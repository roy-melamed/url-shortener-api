"""Explicit disposable SQLite only. Never import this from the pure policy core."""
from contextlib import contextmanager
import json
import os
from pathlib import Path
import sqlite3
from hashlib import sha256
from tempfile import mkdtemp
from threading import RLock
from .core import Blocked, DAY, canonical, digest, mock_id, ns, reconcile, require


class Crash(BaseException):
    pass


class Sandbox:
    def __init__(self, parent, storage_receipt=None):
        require(storage_receipt == "mock-local-fsync", "storage-semantics-unknown")
        parent = Path(parent)
        require(parent.is_absolute() and parent.resolve() == parent and parent.is_dir() and parent.stat().st_mode & 0o777 == 0o700, "disposable-root-invalid")
        self.root = Path(mkdtemp(prefix="coordinator-mock-", dir=parent))
        self.root.chmod(0o700)
        self.identity = (self.root.stat().st_dev, self.root.stat().st_ino)

    @classmethod
    def existing(cls, root, expected_identity):
        sandbox = object.__new__(cls)
        sandbox.root = Path(root)
        require(sandbox.root.is_absolute() and sandbox.root.parent.stat().st_mode & 0o777 == 0o700, "disposable-root-invalid")
        sandbox.identity = tuple(expected_identity)
        sandbox.check()
        return sandbox

    @classmethod
    def request_candidate(cls, source, request, existing=False):
        """Explicitly allocated deterministic destination; never resets existing data."""
        require(type(source) is cls and type(request) is str and len(request) == 36, "candidate-request-invalid")
        source.check()
        candidate = object.__new__(cls)
        candidate.root = source.root.parent / ("coordinator-recovery-" + digest([str(source.root), request]))
        if not existing:
            candidate.root.mkdir(mode=0o700)
        require(candidate.root.is_dir() and not candidate.root.is_symlink(), "candidate-missing")
        candidate.identity = (candidate.root.stat().st_dev, candidate.root.stat().st_ino)
        candidate.check()
        return candidate

    def check(self):
        require(not (self.root / "quarantined").exists(), "quarantined-disabled")
        require(not self.root.is_symlink() and self.root.resolve() == self.root and (self.root.stat().st_dev, self.root.stat().st_ino) == self.identity and self.root.stat().st_mode & 0o777 == 0o700, "root-replaced")
        for name in ("journal.sqlite3", "journal.sqlite3-wal", "journal.sqlite3-shm"):
            path = self.root / name
            require(not path.is_symlink(), "state-symlink")
            if path.exists():
                require(path.is_file() and path.stat().st_mode & 0o777 == 0o600 and path.stat().st_nlink == 1, "state-acl-invalid")

    def quarantine(self):
        path = self.root / "quarantined"
        if not path.exists():
            fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
            try:
                os.write(fd, b"BLOCKED_DISABLED\n")
                os.fsync(fd)
            finally:
                os.close(fd)


SCHEMA = """
CREATE TABLE state(id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL);
CREATE TABLE audit(seq INTEGER PRIMARY KEY, previous TEXT NOT NULL, body TEXT NOT NULL, hash TEXT NOT NULL UNIQUE);
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT,'append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT,'append-only'); END;
PRAGMA user_version=1;
"""


def schema_hash(db):
    return digest(db.execute("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").fetchall())


def preserve_wal(db):
    require(hasattr(db, "setconfig") and hasattr(sqlite3, "SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE"), "wal-preservation-unsupported")
    db.setconfig(sqlite3.SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE, True)
    require(db.getconfig(sqlite3.SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE), "wal-preservation-unsupported")


def read_only(path, expected=None):
    require(path.is_file() and not path.is_symlink(), "state-missing-no-reset")
    db = None
    try:
        db = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=0.05)
        require(db.execute("PRAGMA quick_check").fetchone()[0] == "ok" and db.execute("PRAGMA user_version").fetchone()[0] == 1, "state-integrity")
        body = json.loads(db.execute("SELECT body FROM state WHERE id=1").fetchone()[0])
        previous = "0" * 64
        prior_state = None
        rows = db.execute("SELECT seq,previous,body,hash FROM audit ORDER BY seq").fetchall()
        require(bool(rows), "audit-missing")
        for index, (seq, old, raw, value) in enumerate(rows, 1):
            require(seq == index and old == previous and digest([seq, old, raw]) == value, "audit-integrity")
            historical = json.loads(raw)["state"]
            if prior_state is not None:
                for key in ("scope", "start", "deadline", "start_utc", "deadline_utc"):
                    require(prior_state["control"][key] == historical["control"][key], "immutable-control-changed")
                require(historical["control"]["epoch"] >= prior_state["control"]["epoch"] and historical["storage"] >= prior_state["storage"], "history-regressed")
                require(all(historical["control"][key] >= prior_state["control"][key] for key in ("generation", "high_water", "last_mono")), "clock-lease-history-regressed")
                terminal = prior_state["control"]["state"]
                if terminal in {"STOPPED", "EXPIRED"}:
                    require(historical["control"]["state"] == terminal, "terminal-state-regressed")
                for key in ("issues", "operations", "handles", "runs", "minutes", "stops"):
                    require(prior_state[key].keys() <= historical[key].keys(), "history-regressed")
                for operation, row in prior_state["operations"].items():
                    require(all(historical["operations"][operation][key] == row[key] for key in ("issue", "stage", "token", "fence", "eligibility_hash")), "operation-identity-changed")
                    require(historical["operations"][operation]["attempts"][:len(row["attempts"])] == row["attempts"], "attempt-history-regressed")
                    require(set(row["evidence"]) <= set(historical["operations"][operation]["evidence"]), "evidence-history-regressed")
                    if row["state"] in {"COMPLETED", "FAILED", "CANCELLED", "UNKNOWN"}:
                        require(historical["operations"][operation]["state"] == row["state"], "terminal-operation-regressed")
                for ref, row in prior_state["handles"].items():
                    require(historical["handles"][ref]["deadline"] == row["deadline"] and (not row["revoked"] or historical["handles"][ref]["revoked"]), "credential-history-regressed")
                for request, row in prior_state["stops"].items():
                    require(historical["stops"][request]["identity"] == row["identity"], "request-identity-changed")
                for key in ("runs", "minutes"):
                    require(all(historical[key][item] >= count for item, count in prior_state[key].items()), "budget-regressed")
            prior_state = historical
            previous = value
        require(json.loads(rows[-1][2])["state"] == body, "state-audit-mismatch")
        require(expected is None or previous == expected, "retained-digest-mismatch")
        require(set(body) == {"schema", "control", "snapshot", "issues", "operations", "reservations", "runs", "minutes", "storage", "handles", "stops"} and body["schema"] == schema_hash(db), "state-incomplete")
        require(not body["issues"] or body["snapshot"] is not None, "plan-snapshot-missing")
        if body["snapshot"] is not None:
            reconcile(body["snapshot"], body["issues"])
        control = body["control"]
        require(set(control) == {"state", "scope", "start", "deadline", "start_utc", "deadline_utc", "generation", "epoch", "boot", "session", "anchor_utc", "anchor_mono", "last_mono", "high_water", "reason"}, "control-incomplete")
        require(ns(control["start_utc"]) == control["start"] and ns(control["deadline_utc"]) == control["deadline"], "control-incomplete")
        require(all(type(control[key]) is int and control[key] >= 0 for key in ("start", "deadline", "generation", "epoch", "anchor_utc", "anchor_mono", "last_mono", "high_water")), "control-incomplete")
        require(control["deadline"] == control["start"] + 14 * DAY and mock_id(control["boot"]) and (control["session"] is None or mock_id(control["session"])), "control-incomplete")
        require(control["state"] in {"DISABLED", "ARMED_MOCK", "STOPPING", "STOPPED", "EXPIRED"} and type(control["epoch"]) is int and 0 <= control["epoch"] < 2 ** 63 and 1 <= control["generation"] < 2 ** 63, "state-invalid")
        require(type(body["storage"]) is int and 0 <= body["storage"] <= 1024 ** 3, "state-incomplete")
        require(all(type(body[key]) is dict for key in ("issues", "operations", "reservations", "runs", "minutes", "handles", "stops")), "state-incomplete")
        require(set(body["issues"]) <= set(control["scope"]["issues"]) and len(body["issues"]) <= 25, "issue-scope-invalid")
        for issue, row in body["issues"].items():
            require(type(row) is dict and row["state"] in {"PLANNED", "CLAIMED", "INFLIGHT", "UNKNOWN", "CANCELLED", "COMPLETED", "FAILED"} and row["stage"] in {"implementation", "review", "qa"} and type(row["fingerprint"]) is str and len(row["fingerprint"]) == 64, "issue-incomplete")
            require(type(row["eligible"]) is bool and type(row["plan_lease"]) is list and len(row["plan_lease"]) == 4, "plan-incomplete")
        require(body["operations"].keys() == body["reservations"].keys(), "reservation-incomplete")
        for operation, row in body["operations"].items():
            require(type(operation) is str and len(operation) == 64 and mock_id(row["issue"]) and row["issue"] in body["issues"], "operation-incomplete")
            require(row["state"] in {"CLAIMED", "INFLIGHT", "UNKNOWN", "CANCELLED", "COMPLETED", "FAILED"} and type(row["fence"]) is list and len(row["fence"]) == 5 and row["fence"][3] == operation, "operation-incomplete")
            require(type(row["attempts"]) is list and 1 <= len(row["attempts"]) <= 3 and len(set(row["attempts"])) == len(row["attempts"]) and all(type(item) is str and len(item) == 64 for item in row["attempts"]), "attempts-incomplete")
            require(type(row["evidence"]) is list and all(mock_id(item) for item in row["evidence"]), "evidence-incomplete")
            require(row["stage"] in {"implementation", "review", "qa"} and type(row["token"]) is str and len(row["token"]) == 64 and type(row["next"]) is int and row["next"] >= 0, "operation-incomplete")
            require(type(row["eligibility_hash"]) is str and len(row["eligibility_hash"]) == 64, "operation-incomplete")
            reservation = body["reservations"][operation]
            require(reservation["run"] in control["scope"]["runs"] and type(reservation["active"]) is bool and all(type(reservation[key]) is int and reservation[key] >= 0 for key in ("records", "storage", "timeout")), "reservation-incomplete")
        require(sum(row["active"] for row in body["reservations"].values()) <= 1, "concurrent-reservation-invalid")
        for ref, row in body["handles"].items():
            require(ref in control["scope"]["credential_refs"] and type(row["deadline"]) is int and 0 <= row["deadline"] <= control["deadline"] and type(row["revoked"]) is bool, "handle-incomplete")
        for request, row in body["stops"].items():
            require(type(request) is str and type(row) is dict and set(row) == {"identity", "receipt"} and type(row["identity"]) is str and len(row["identity"]) == 64 and type(row["receipt"]) is dict, "control-evidence-incomplete")
        require(all(type(count) is int and 0 <= count <= 100 for count in body["runs"].values()) and all(type(count) is int and 0 <= count <= 200 for count in body["minutes"].values()), "budget-incomplete")
        return body, previous
    except (sqlite3.Error, OSError, ValueError, TypeError, KeyError, IndexError, AttributeError, OverflowError):
        raise Blocked("state-unreadable-no-reset") from None
    finally:
        if db:
            db.close()


class Journal:
    def __init__(self, sandbox, initial=None, expected=None):
        require(type(sandbox) is Sandbox, "explicit-sandbox-required")
        sandbox.check()
        self.sandbox = sandbox
        self.path = sandbox.root / "journal.sqlite3"
        self.fault = None
        self._event = None
        self.db = None
        self.gate = RLock()
        if initial is None:
            read_only(self.path, expected)
            require(type(expected) is str and len(expected) == 64, "retained-digest-required")
        else:
            require(not self.path.exists(), "no-reset")
            fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
            os.close(fd)
        try:
            self.db = sqlite3.connect(self.path, isolation_level=None, timeout=0.05, check_same_thread=False)
            preserve_wal(self.db)
            self.db.execute("PRAGMA journal_mode=WAL")
            self.db.execute("PRAGMA wal_autocheckpoint=0")
            self.db.execute("PRAGMA synchronous=FULL")
            self.db.execute("PRAGMA foreign_keys=ON")
            if initial is not None:
                self.db.executescript("BEGIN IMMEDIATE;" + SCHEMA)
                initial = json.loads(canonical(initial))
                initial["schema"] = schema_hash(self.db)
                self.db.execute("INSERT INTO state VALUES(1,?)", (canonical(initial),))
                raw = canonical({"event": "initialize-disabled", "state": initial})
                self.db.execute("INSERT INTO audit VALUES(1,?,?,?)", ("0" * 64, raw, digest([1, "0" * 64, raw])))
                self.db.execute("COMMIT")
                self.sync()
            self.body, self.tail = read_only(self.path, expected)
        except (sqlite3.Error, OSError):
            raise Blocked("state-open-failed-no-reset") from None

    def sync(self):
        if self._fault("before-fsync"):
            raise Crash()
        if self.fault == "fsync":
            raise Blocked("durability-unconfirmed")
        for path in (self.path, Path(str(self.path) + "-wal"), self.sandbox.root):
            if path.exists():
                fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
                try:
                    os.fsync(fd)
                finally:
                    os.close(fd)
        if self._fault("after-fsync"):
            raise Crash()

    def _fault(self, point):
        return self.fault in {point, f"{self._event}:{point}"}

    @contextmanager
    def transaction(self, event):
        require(self.db is not None, "journal-closed")
        self.sandbox.check()
        if self.fault == "storage":
            raise Blocked("storage-full")
        try:
            self._event = event
            self.db.execute("BEGIN IMMEDIATE")
            body, tail = read_only(self.path, self.tail)
            yield body
            if self._fault("before-commit"):
                raise Crash()
            if body != self.body:
                seq = self.db.execute("SELECT count(*) FROM audit").fetchone()[0] + 1
                raw = canonical({"event": event, "state": body})
                value = digest([seq, tail, raw])
                self.db.execute("UPDATE state SET body=? WHERE id=1", (canonical(body),))
                self.db.execute("INSERT INTO audit VALUES(?,?,?,?)", (seq, tail, raw, value))
            self.db.execute("COMMIT")
            if self._fault("after-sqlite-commit"):
                raise Crash()
            self.sync()
            self.body, self.tail = read_only(self.path)
            if self._fault("after-commit"):
                raise Crash()
        except BaseException as error:
            if self.db.in_transaction:
                self.db.execute("ROLLBACK")
            if isinstance(error, (sqlite3.Error, OSError)):
                raise Blocked("journal-failed") from None
            raise

    def backup(self, candidate):
        require(type(candidate) is Sandbox and candidate is not self.sandbox, "candidate-invalid")
        candidate.check()
        target = candidate.root / "journal.sqlite3"
        require(not target.exists(), "candidate-not-empty")
        fd = os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
        os.close(fd)
        destination = sqlite3.connect(target)
        try:
            self.db.backup(destination)
        finally:
            destination.close()
        fd = os.open(target, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
        body, tail = read_only(target, self.tail)
        fd = os.open(candidate.root, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
        return {"snapshot": digest([tail, body]), "tail": tail, "file": target.name, "file_hash": sha256(target.read_bytes()).hexdigest(), "code": body["control"]["scope"]["source"], "config": body["control"]["scope"]["config"], "state": digest(body), "evidence": tail}

    def close(self):
        if self.db is not None:
            self.db.close()
            self.db = None

    def restore_union(self, selected, candidate, selected_tail, command=None):
        """Restore the selected snapshot, then append the verified current suffix.

        The authoritative original is read-only throughout. Prefix comparison
        rejects divergent histories rather than attempting a lossy state merge.
        """
        selected.check()
        candidate.check()
        current, tail = read_only(self.path, self.tail)
        source = sqlite3.connect((selected.root / "journal.sqlite3").as_uri() + "?mode=ro", uri=True)
        restored = None
        try:
            read_only(selected.root / "journal.sqlite3", selected_tail)
            target = candidate.root / "journal.sqlite3"
            fd = os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
            os.close(fd)
            restored = sqlite3.connect(target, isolation_level=None)
            preserve_wal(restored)
            source.backup(restored)
            saved_rows = restored.execute("SELECT seq,previous,body,hash FROM audit ORDER BY seq").fetchall()
            current_rows = self.db.execute("SELECT seq,previous,body,hash FROM audit ORDER BY seq").fetchall()
            require(current_rows[:len(saved_rows)] == saved_rows, "rollback-divergent-history")
            restored.execute("PRAGMA synchronous=FULL")
            restored.execute("BEGIN IMMEDIATE")
            restored.executemany("INSERT INTO audit VALUES(?,?,?,?)", current_rows[len(saved_rows):])
            restored.execute("UPDATE state SET body=? WHERE id=1", (canonical(current),))
            restored.execute("COMMIT")
        finally:
            source.close()
            if restored is not None:
                restored.close()
        recovered = Journal(candidate, expected=tail)
        try:
            # Only the NEW candidate gains a rollback event. Original/snapshot
            # history and WAL are retained byte-for-byte.
            with recovered.transaction("rollback-selected-snapshot-union") as body:
                key = digest(["rollback", selected_tail, tail])[:32]
                body["stops"][key] = {"identity": tail, "receipt": {"outcome": "ROLLBACK_DISABLED", "selected": selected_tail, "authoritative": tail}}
                if command is not None:
                    request, identity = command
                    require(request not in body["stops"], "conflicting-request")
                    body["stops"][request] = {"identity": identity, "receipt": {"outcome": "ROLLBACK_COMMAND_COMPLETE", "selected": selected_tail, "authoritative": tail, "enabled": False}}
            require(all(recovered.body[key] == current[key] for key in current if key != "stops"), "rollback-unverified")
            return {"tail": recovered.tail, "selected": selected_tail, "authoritative": tail, "enabled": False}
        finally:
            recovered.close()
