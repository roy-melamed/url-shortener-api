"""Pure synthetic identities/history classification. Never trusts Jira prose."""
from dataclasses import dataclass
from datetime import datetime, timezone
from hashlib import sha256
import json
import re


class OfflineError(Exception):
    """Only a fixed reason code crosses a failure boundary, never input content."""


def require(condition: bool, code: str) -> None:
    if not condition:
        raise OfflineError(code)


def utc(value: object) -> datetime:
    require(isinstance(value, str) and bool(re.fullmatch(
        r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z", value)), "timestamp-invalid")
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise OfflineError("timestamp-invalid") from None


def stamp(value: datetime) -> str:
    require(value.tzinfo == timezone.utc, "clock-not-utc")
    return value.isoformat(timespec="microseconds").replace("+00:00", "Z")


def canonical(parts: tuple[str, ...]) -> str:
    """Length-delimited UTF-8 identity, independent of install/scan/timestamp/key."""
    return sha256(b"".join(len(p.encode()).to_bytes(4, "big") + p.encode() for p in parts)).hexdigest()


def numeric(value: object) -> str:
    require(isinstance(value, str) and bool(re.fullmatch(r"99[0-9]{4}", value)), "synthetic-id-required")
    return value


@dataclass(frozen=True)
class FixtureConfig:
    site: str
    project_id: str
    project_key: str
    issue_types: tuple[str, ...]
    status_ids: tuple[str, ...]
    evidence_id: str
    done_id: str
    humans: tuple[str, ...]
    version: str = "fixture-config-v1"
    work_revision: str = "fixture-work-v1"

    def __post_init__(self) -> None:
        require(self.site == "fixture-jira.invalid" and self.project_key == "SYNTH", "fixture-scope-required")
        require(type(self.issue_types) is tuple and type(self.status_ids) is tuple
                and type(self.humans) is tuple, "config-invalid")
        for value in (self.project_id, self.evidence_id, self.done_id, *self.issue_types, *self.status_ids):
            numeric(value)
        require(bool(self.issue_types) and len(set(self.issue_types)) == len(self.issue_types), "config-invalid")
        require(len(set(self.status_ids)) == len(self.status_ids) and self.evidence_id != self.done_id
                and {self.evidence_id, self.done_id} <= set(self.status_ids), "config-invalid")
        require(bool(self.humans) and len(set(self.humans)) == len(self.humans), "config-invalid")
        require(all(isinstance(a, str) and re.fullmatch(r"fixture-human-[a-z0-9-]{1,40}", a)
                    for a in self.humans), "synthetic-human-required")
        require(self.version == "fixture-config-v1" and self.work_revision == "fixture-work-v1", "config-invalid")

    @property
    def digest(self) -> str:
        # Preserve collection boundaries as well as length-delimited scalar
        # boundaries: moving an ID between type/status sets must change policy.
        document = {"site": self.site, "project": self.project_id, "key": self.project_key,
                    "types": sorted(self.issue_types), "statuses": sorted(self.status_ids),
                    "evidence": self.evidence_id, "done": self.done_id,
                    "humans": sorted(self.humans), "version": self.version,
                    "work_revision": self.work_revision}
        return canonical(("fixture-config-v1", json.dumps(document, sort_keys=True, separators=(",", ":"))))


@dataclass(frozen=True)
class Issue:
    issue_id: str
    project: str
    issue_type: str
    status: str
    updated: str


def parse_issue(raw: object, config: FixtureConfig) -> Issue:
    try:
        require(type(raw) is dict and type(raw["fields"]) is dict, "issue-invalid")
        fields = raw["fields"]
        issue = Issue(numeric(raw["id"]), numeric(fields["project"]["id"]),
                      numeric(fields["issuetype"]["id"]), numeric(fields["status"]["id"]),
                      stamp(utc(fields["updated"])))
        require(issue.project == config.project_id and issue.issue_type in config.issue_types
                and issue.status in config.status_ids, "issue-scope-mismatch")
        return issue
    except (KeyError, TypeError, AttributeError):
        raise OfflineError("issue-invalid") from None


@dataclass(frozen=True)
class Decision:
    event_id: str
    site: str
    issue_id: str
    history_id: str
    from_id: str
    to_id: str
    created: str
    actor: str | None
    classification: str
    reason: str
    superseded: bool


@dataclass(frozen=True)
class Snapshot:
    issue: Issue
    histories: tuple[tuple[str, str], ...]  # history ID + normalized metadata digest
    decisions: tuple[Decision, ...]


def classify(issue: Issue, histories: object, config: FixtureConfig,
             fence: str, observed_at: str) -> Snapshot:
    require(type(issue) is Issue and issue.project == config.project_id and issue.issue_type in config.issue_types
            and issue.status in config.status_ids, "issue-scope-mismatch")
    numeric(issue.issue_id)
    require(type(histories) is list and len(histories) <= 10000, "histories-invalid")
    fence_time, now = utc(fence), utc(observed_at)
    require(utc(issue.updated) <= now, "future-issue")
    records: dict[str, tuple[str, str | None, str, tuple[str, str] | None]] = {}
    for raw in histories:
        require(type(raw) is dict, "history-invalid")
        identity = raw.get("id")
        require(isinstance(identity, str) and bool(re.fullmatch(r"[A-Za-z0-9_.:-]{1,128}", identity)), "history-id-invalid")
        created = stamp(utc(raw.get("created")))
        require(utc(created) <= utc(issue.updated), "history-after-issue")
        author = raw.get("author")
        actor, actor_reason = None, "actor-missing"
        if type(author) is dict:
            account = author.get("accountId")
            if isinstance(account, str) and re.fullmatch(r"fixture-(?:human|app|machine)-[a-z0-9-]{1,40}", account):
                actor = account
            if author.get("accountType") != "atlassian":
                actor_reason = "actor-not-human-type"
            elif author.get("active") is not True:
                actor_reason = "actor-not-active"
            elif actor not in config.humans:
                actor_reason = "actor-not-allowlisted"
            else:
                actor_reason = "actor-matched-fixture"
        require(type(raw.get("items")) is list and 0 < len(raw["items"]) <= 100, "items-invalid")
        statuses = set()
        for item in raw["items"]:
            require(type(item) is dict and isinstance(item.get("fieldId"), str), "item-invalid")
            require(item["fieldId"] not in {"project", "issuetype"}, "historical-membership-ambiguous")
            if item["fieldId"] != "status":
                continue
            source, target = numeric(item.get("from")), numeric(item.get("to"))
            require(source in config.status_ids and target in config.status_ids, "status-mapping-mismatch")
            statuses.add((source, target))
        require(len(statuses) <= 1, "contradictory-status-items")
        status = next(iter(statuses), None)
        normalized = (created, actor, actor_reason, status)
        require(identity not in records or records[identity] == normalized, "contradictory-history-id")
        records[identity] = normalized
    ordered = sorted(records.items(), key=lambda row: (row[1][0], row[0]))
    status_rows = [(identity, record) for identity, record in ordered if record[3] is not None]
    # Equal-time distinct status transitions cannot prove ordering: quarantine the scan.
    by_time: dict[str, set[tuple[str, str]]] = {}
    for _, record in status_rows:
        by_time.setdefault(record[0], set()).add(record[3])
    require(all(len(values) <= 1 for values in by_time.values()), "ambiguous-status-order")
    if status_rows:
        require(status_rows[-1][1][3][1] == issue.status, "current-history-mismatch")
    for (_, previous), (_, current) in zip(status_rows, status_rows[1:]):
        if previous[0] < current[0]:
            require(previous[3][1] == current[3][0], "status-history-gap")
    decisions = []
    fingerprints = []
    for identity, record in ordered:
        created, actor, actor_reason, status = record
        fingerprints.append((identity, sha256(json.dumps(record, separators=(",", ":")).encode()).hexdigest()))
        if status is None:
            continue
        source, target = status
        if utc(created) < fence_time:
            classification, reason = "historical", "before-simulated-fence"
        elif (source, target) != (config.evidence_id, config.done_id):
            classification, reason = "not-qualifying", "status-path-mismatch"
        elif actor_reason != "actor-matched-fixture":
            classification, reason = "actor-rejected", actor_reason
        else:
            classification, reason = "eligible", "simulated-match-only"
        superseded = any(r[0] > created and r[3][1] != config.done_id for _, r in status_rows)
        decisions.append(Decision(canonical(("event-v1", config.site, issue.issue_id, identity,
                                             "status", source, target)), config.site, issue.issue_id,
                                  identity, source, target, created, actor,
                                  classification, reason, superseded))
    return Snapshot(issue, tuple(fingerprints), tuple(decisions))
