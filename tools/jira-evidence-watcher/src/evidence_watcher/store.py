"""Disposable simulation SQLite only. No operational path/arming/delivery API."""
from contextlib import contextmanager
from datetime import timedelta
import json
import re
from pathlib import Path
import sqlite3
from tempfile import TemporaryDirectory

from .model import FixtureConfig, OfflineError, Snapshot, canonical, numeric, require, stamp, utc


class InjectedCrash(BaseException):
    pass


class FaultPlan:
    def __init__(self, point: str = ""):
        require(point in {"", "after-begin", "after-event", "after-outbox", "before-watermark",
                          "after-watermark", "before-commit", "after-commit"}, "fault-plan-invalid")
        self.point = point

    def check(self, point: str) -> None:
        if point == self.point:
            raise InjectedCrash(point)


SCHEMA = """
CREATE TABLE installation(id INTEGER PRIMARY KEY CHECK(id=1), fence TEXT NOT NULL,
 config_hash TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode='simulation'));
CREATE TRIGGER immutable_installation_update BEFORE UPDATE ON installation
 BEGIN SELECT RAISE(ABORT,'immutable-simulation-fence'); END;
CREATE TRIGGER immutable_installation_delete BEFORE DELETE ON installation
 BEGIN SELECT RAISE(ABORT,'immutable-simulation-fence'); END;
CREATE TABLE engine_state(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL,
 completed_upper TEXT, full_upper TEXT, baseline_complete INTEGER NOT NULL DEFAULT 0,
 last_clock TEXT, next_request TEXT, not_before TEXT, retry_cycles INTEGER NOT NULL DEFAULT 0,
 last_error TEXT);
CREATE TABLE scan_runs(scan_id TEXT PRIMARY KEY, kind TEXT NOT NULL, lower_bound TEXT,
 upper_bound TEXT NOT NULL, revision INTEGER NOT NULL, state TEXT NOT NULL);
CREATE TABLE inventory(issue_id TEXT PRIMARY KEY, updated TEXT NOT NULL, status_id TEXT NOT NULL);
CREATE TABLE history_registry(issue_id TEXT NOT NULL, history_id TEXT NOT NULL,
 digest TEXT NOT NULL, PRIMARY KEY(issue_id,history_id));
CREATE TABLE processed_events(event_id TEXT PRIMARY KEY, site TEXT NOT NULL,
 issue_id TEXT NOT NULL, history_id TEXT NOT NULL, field_id TEXT NOT NULL CHECK(field_id='status'),
 from_id TEXT NOT NULL, to_id TEXT NOT NULL, created TEXT NOT NULL, actor TEXT,
 classification TEXT NOT NULL, reason TEXT NOT NULL, superseded INTEGER NOT NULL,
 UNIQUE(site,issue_id,history_id,field_id,from_id,to_id));
CREATE TABLE simulated_work_identities(work_id TEXT PRIMARY KEY, issue_id TEXT NOT NULL,
 revision TEXT NOT NULL, UNIQUE(issue_id,revision));
CREATE TABLE notification_outbox(event_id TEXT PRIMARY KEY REFERENCES processed_events(event_id),
 work_id TEXT NOT NULL REFERENCES simulated_work_identities(work_id), payload TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state='pending-offline'));
PRAGMA user_version=1;
"""


class DisposableState:
    """Owns a NEW temp directory; cannot point at an application/operational DB."""
    def __init__(self):
        self._temporary = TemporaryDirectory(prefix="jira-evidence-watcher-test-")
        self._directory = Path(self._temporary.name)
        self.directory.chmod(0o700)
        self._stores = []

    @property
    def directory(self) -> Path:
        return self._directory

    def __enter__(self):
        return self

    def __exit__(self, *_):
        for store in self._stores:
            store.close()
        self._temporary.cleanup()

    def create(self, config: FixtureConfig, fence: str, created_at: str):
        require(utc(fence) - utc(created_at) >= timedelta(minutes=5), "simulated-future-fence-required")
        return SimulationStore(self, config, fence)

    def reopen(self, config: FixtureConfig):
        return SimulationStore(self, config)


class SimulationStore:
    def __init__(self, sandbox: DisposableState, config: FixtureConfig, fence: str | None = None):
        require(type(sandbox) is DisposableState and type(config) is FixtureConfig, "disposable-state-required")
        path = sandbox.directory / "events.sqlite3"
        require(not path.is_symlink(), "state-invalid")
        self._config = config
        self._db = None
        try:
            if fence is not None:
                with path.open("xb"):
                    pass
            else:
                require(path.is_file(), "state-missing-no-reset")
            path.chmod(0o600)
            self._db = sqlite3.connect(path, isolation_level=None, timeout=0.1)
            self._db.row_factory = sqlite3.Row
            self._db.execute("PRAGMA foreign_keys=ON")
            self._db.execute("PRAGMA journal_mode=WAL")
            self._db.execute("PRAGMA synchronous=FULL")
            if fence is not None:
                self._db.executescript("BEGIN IMMEDIATE;" + SCHEMA)
                self._db.execute("INSERT INTO installation VALUES(1,?,?,'simulation')", (stamp(utc(fence)), config.digest))
                self._db.execute("INSERT INTO engine_state(id,revision) VALUES(1,0)")
                self._db.execute("COMMIT")
            require(self._db.execute("PRAGMA quick_check").fetchone()[0] == "ok", "state-integrity")
            require(self._db.execute("PRAGMA user_version").fetchone()[0] == 1, "state-schema")
            row = self._db.execute("SELECT * FROM installation WHERE id=1").fetchone()
            require(row is not None and row["config_hash"] == config.digest and row["mode"] == "simulation", "state-config-mismatch")
            self._fence = row["fence"]
            for file in sandbox.directory.iterdir():
                file.chmod(0o600)
            sandbox._stores.append(self)
        except (sqlite3.Error, OSError):
            self.close()
            raise OfflineError("state-open-failed-no-reset") from None
        except BaseException:
            self.close()
            raise

    def close(self) -> None:
        if self._db is not None:
            self._db.close()
            self._db = None

    @property
    def config(self) -> FixtureConfig:
        return self._config

    @property
    def fence(self) -> str:
        return self._fence

    @contextmanager
    def transaction(self):
        try:
            self._db.execute("BEGIN IMMEDIATE")
            yield
            self._db.execute("COMMIT")
        except BaseException as error:
            if self._db.in_transaction:
                self._db.execute("ROLLBACK")
            if isinstance(error, sqlite3.Error):
                raise OfflineError("storage-transaction-failed") from None
            raise

    def state(self) -> dict:
        return dict(self._db.execute("SELECT * FROM engine_state WHERE id=1").fetchone())

    def known_issues(self) -> set[str]:
        return {row[0] for row in self._db.execute("SELECT issue_id FROM inventory")}

    def begin_scan(self, kind: str, lower: str | None, upper: str) -> str:
        require(kind in {"bootstrap", "incremental", "full"}, "scan-kind-invalid")
        upper = stamp(utc(upper))
        lower = stamp(utc(lower)) if lower is not None else None
        require(lower is None or lower <= upper, "scan-window-invalid")
        state = self.state()
        # A sequence ID is local bookkeeping only, never an event/work identity.
        sequence = self._db.execute("SELECT count(*) FROM scan_runs").fetchone()[0]
        scan = canonical(("scan", str(sequence), kind, upper, str(state["revision"])))
        with self.transaction():
            self._db.execute("INSERT INTO scan_runs VALUES(?,?,?,?,?,'collecting')",
                             (scan, kind, lower, upper, state["revision"]))
        return scan

    def apply(self, scan_id: str, snapshots: tuple[Snapshot, ...], observed_at: str,
              fault: FaultPlan | None = None) -> None:
        require(fault is None or type(fault) is FaultPlan, "fault-plan-invalid")
        fault = fault or FaultPlan()
        with self.transaction():
            fault.check("after-begin")
            installation = self._db.execute("SELECT * FROM installation WHERE id=1").fetchone()
            require(installation["config_hash"] == self.config.digest and installation["fence"] == self.fence
                    and installation["mode"] == "simulation", "state-config-mismatch")
            scan = self._db.execute("SELECT * FROM scan_runs WHERE scan_id=?", (scan_id,)).fetchone()
            state = self.state()
            require(scan is not None and scan["state"] == "collecting"
                    and scan["revision"] == state["revision"], "stale-scan")
            if scan["kind"] == "incremental":
                require(state["baseline_complete"] == 1, "baseline-required")
                require(state["completed_upper"] is None or scan["upper_bound"] >= state["completed_upper"], "watermark-regression")
            for snapshot in snapshots:
                require(type(snapshot) is Snapshot, "snapshot-invalid")
                issue = snapshot.issue
                numeric(issue.issue_id)
                require(issue.project == self.config.project_id and issue.issue_type in self.config.issue_types
                        and issue.status in self.config.status_ids, "snapshot-scope-mismatch")
                incoming = dict(snapshot.histories)
                previous = dict(self._db.execute("SELECT history_id,digest FROM history_registry WHERE issue_id=?", (issue.issue_id,)))
                require(previous.keys() <= incoming.keys(), "history-coverage-regressed")
                require(all(incoming[key] == digest for key, digest in previous.items()), "history-identity-conflict")
                self._db.executemany("INSERT OR IGNORE INTO history_registry VALUES(?,?,?)",
                                     ((issue.issue_id, key, digest) for key, digest in incoming.items()))
                for event in snapshot.decisions:
                    reasons = {"historical": {"before-simulated-fence"},
                               "not-qualifying": {"status-path-mismatch"},
                               "eligible": {"simulated-match-only"},
                               "actor-rejected": {"actor-missing", "actor-not-human-type", "actor-not-active", "actor-not-allowlisted"}}
                    require(event.reason in reasons.get(event.classification, set())
                            and event.history_id in incoming
                            and event.from_id in self.config.status_ids and event.to_id in self.config.status_ids
                            and (event.actor is None or bool(re.fullmatch(r"fixture-(?:human|app|machine)-[a-z0-9-]{1,40}", event.actor))),
                            "event-decision-conflict")
                    require(event.event_id == canonical(("event-v1", self.config.site, issue.issue_id,
                            event.history_id, "status", event.from_id, event.to_id))
                            and event.site == self.config.site and event.issue_id == issue.issue_id,
                            "event-identity-conflict")
                    require((utc(event.created) < utc(self.fence)) == (event.classification == "historical")
                            and utc(event.created) <= utc(issue.updated)
                            and (event.classification != "eligible" or
                                 (event.actor in self.config.humans and event.reason == "simulated-match-only"
                                  and (event.from_id, event.to_id) == (self.config.evidence_id, self.config.done_id))),
                            "event-decision-conflict")
                    facts = (event.site, event.issue_id, event.history_id, "status", event.from_id,
                             event.to_id, event.created, event.actor, event.classification, event.reason)
                    previous_event = self._db.execute("SELECT site,issue_id,history_id,field_id,from_id,to_id,created,actor,classification,reason FROM processed_events WHERE event_id=?", (event.event_id,)).fetchone()
                    require(previous_event is None or tuple(previous_event) == facts, "event-identity-conflict")
                    self._db.execute("INSERT OR IGNORE INTO processed_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                                     (event.event_id, *facts, int(event.superseded)))
                    self._db.execute("UPDATE processed_events SET superseded=max(superseded,?) WHERE event_id=?",
                                     (int(event.superseded), event.event_id))
                    fault.check("after-event")
                    if event.classification == "eligible":
                        work_id = canonical(("simulated-work-v1", self.config.site, issue.issue_id, self.config.work_revision))
                        self._db.execute("INSERT OR IGNORE INTO simulated_work_identities VALUES(?,?,?)",
                                         (work_id, issue.issue_id, self.config.work_revision))
                        payload = json.dumps({"kind": "offline-reconcile-fact", "event_id": event.event_id,
                                              "simulated_work_id": work_id}, sort_keys=True)
                        self._db.execute("INSERT OR IGNORE INTO notification_outbox VALUES(?,?,?,'pending-offline')",
                                         (event.event_id, work_id, payload))
                        fault.check("after-outbox")
                self._db.execute("INSERT INTO inventory VALUES(?,?,?) ON CONFLICT(issue_id) DO UPDATE SET updated=excluded.updated,status_id=excluded.status_id",
                                 (issue.issue_id, issue.updated, issue.status))
            fault.check("before-watermark")
            if scan["kind"] == "incremental":
                self._db.execute("UPDATE engine_state SET completed_upper=? WHERE id=1", (scan["upper_bound"],))
            else:
                self._db.execute("UPDATE engine_state SET full_upper=?,baseline_complete=1 WHERE id=1", (scan["upper_bound"],))
            self._db.execute("UPDATE engine_state SET revision=revision+1,last_clock=?,retry_cycles=0,last_error=NULL WHERE id=1", (stamp(utc(observed_at)),))
            self._db.execute("UPDATE scan_runs SET state='applied' WHERE scan_id=?", (scan_id,))
            fault.check("after-watermark")
            fault.check("before-commit")
        fault.check("after-commit")

    def request_slot(self, now: str) -> str:
        with self.transaction():
            state = self.state()
            slot = max(value for value in (now, state["next_request"], state["not_before"]) if value)
            self._db.execute("UPDATE engine_state SET next_request=? WHERE id=1", (stamp(utc(slot) + timedelta(seconds=10)),))
        return slot

    def defer(self, when: str, code: str, exhausted: bool = False) -> None:
        require(code in {"rate-limited", "transient", "permanent-contract", "cycle-exhausted"}, "retry-code-invalid")
        with self.transaction():
            self._db.execute("UPDATE engine_state SET not_before=max(coalesce(not_before,''),?),last_error=?,retry_cycles=retry_cycles+? WHERE id=1",
                             (stamp(utc(when)), code, int(exhausted)))

    def counts(self) -> dict[str, int]:
        return {name: self._db.execute("SELECT count(*) FROM " + name).fetchone()[0]
                for name in ("processed_events", "notification_outbox", "simulated_work_identities", "history_registry")}

    def inspect_outbox(self) -> tuple[dict, ...]:
        """Local pending-record inspection only; deliberately no drain/send/ack API."""
        return tuple(dict(row) for row in self._db.execute("SELECT * FROM notification_outbox ORDER BY event_id"))
