"""Deterministic policies; no I/O, clock discovery, scheduling or effect adapters."""
from dataclasses import dataclass
from datetime import datetime, timezone
from hashlib import sha256
import json
import re
from pathlib import PurePath

SECOND = 1_000_000_000
DAY = 86400 * SECOND
GIB = 1024 ** 3


class Blocked(Exception):
    """Only fixed reason codes cross the local boundary."""


def require(value, code="invalid-fixture"):
    if not value:
        raise Blocked(code)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def digest(value):
    return sha256(canonical(value).encode()).hexdigest()


def mock_id(value):
    return type(value) is str and re.fullmatch(r"mock-[a-z0-9-]{1,64}", value) is not None


def ns(value):
    require(type(value) is str, "timestamp-unknown")
    match = re.fullmatch(r"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z", value)
    require(match, "timestamp-unknown")
    try:
        date = datetime.strptime(match[1], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)
        epoch = datetime(1970, 1, 1, tzinfo=timezone.utc)
        delta = date - epoch
        return (delta.days * 86400 + delta.seconds) * SECOND + int((match[2] or "").ljust(9, "0"))
    except (ValueError, OverflowError):
        raise Blocked("timestamp-unknown") from None


def stamp(value):
    require(type(value) is int and 0 <= value <= ns("9999-12-31T23:59:59Z"), "timestamp-unknown")
    return datetime.fromtimestamp(value // SECOND, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S") + f".{value % SECOND:09d}Z"


def credential_deadline(fixture_deadline, issued, requested, provider):
    # Both trusted timestamps are explicit; neither a local now() nor a refresh.
    require(all(type(item) is int and item >= 0 for item in (fixture_deadline, issued, requested, provider)), "credential-time-unknown")
    return min(fixture_deadline, min(issued, requested) + 3600 * SECOND, provider)


def reservation_fits(records, issues, minutes, storage, active):
    return all(type(value) is int and 0 <= value <= cap for value, cap in zip((records, issues, minutes, storage, active), (100, 25, 200, GIB, 1)))


def containment_plan(control, references):
    return {"operator": "roy", "authenticated": False, "fixture": control["scope"]["fixture"], "start": control["start_utc"], "deadline": control["deadline_utc"], "epoch": control["epoch"], "resources": control["scope"]["resources"], "credential_refs": sorted(references), "operations": {"repo": "disable-actions-and-write-access", "actions": "cancel-recorded-runs", "workflows": "disable-all-fixture-workflows", "jira": "remove-fixture-project-write-membership", "principals": "revoke-dedicated-grants", "token-store": "invalidate-local-handles", "resources": "deny-fixture-writes"}, "github_token_operation": "DELETE /installation/token", "jira_grant_operation": "BLOCKED_SUPPORTED_OWNER_ADMIN_OPERATION_UNVERIFIED", "external": "BLOCKED_UNEXECUTED"}


def clock_verdict(control, clock, deadline):
    require(clock.suspend_supported is True, "suspend-clock-unknown")
    require(clock.boot == control["boot"], "boot-mismatch")
    require(type(clock.utc) is int and type(clock.mono) is int, "clock-invalid")
    require(clock.utc >= control["high_water"] and clock.mono >= control["last_mono"], "clock-regression")
    utc_elapsed = clock.utc - control["anchor_utc"]
    mono_elapsed = clock.mono - control["anchor_mono"]
    remaining = min(deadline - clock.utc, deadline - control["anchor_utc"] - mono_elapsed)
    # A forward deadline crossing expires, even if the watchdog was delayed.
    if remaining <= 0:
        return "EXPIRED"
    require(abs(utc_elapsed - mono_elapsed) <= SECOND, "clock-disagreement")
    return "CURRENT"


@dataclass
class MockClock:
    utc: int
    mono: int = 0
    boot: str = "mock-boot"
    suspend_supported: bool = False

    def advance(self, amount):
        require(type(amount) is int and 0 <= amount <= 365 * DAY, "clock-step-invalid")
        self.utc += amount
        self.mono += amount


def validate_document(document_path, expected_revision, content):
    # v9's exact fullmatch snippet, with missing/type inputs rejected first.
    if type(document_path) is not str or type(expected_revision) is not int or expected_revision < 1 or type(content) is not str or not content.splitlines():
        return False
    n = str(expected_revision)
    filename = re.fullmatch(rf".+\.v{re.escape(n)}\.md", PurePath(document_path).name)
    title = re.fullmatch(rf"# Local Coordinator Stop, Expiry, and Recovery Requirements v{re.escape(n)}", content.splitlines()[0])
    metadata = next((line for line in content.splitlines() if line.startswith("**Version:**")), "")
    metadata = re.fullmatch(rf"\*\*Version:\*\* 2026-11-22-local-stop-expiry\.{re.escape(n)}", metadata)
    return bool(filename and title and metadata)


def valid_format(content):
    if type(content) is not str or "\r" in content or not content.endswith("\n") or content.endswith("\n\n") or any(line.endswith((" ", "\t")) for line in content.splitlines()):
        return False
    fence = None
    for line in content.splitlines():
        match = re.fullmatch(r" {0,3}(`{3,}|~{3,})(.*)", line)
        if match is None:
            continue
        marker, suffix = match.groups()
        if fence is None:
            if marker[0] == "`" and "`" in suffix:
                return False
            fence = marker
        elif marker[0] == fence[0] and len(marker) >= len(fence) and not suffix.strip():
            fence = None
    return fence is None


def completion(stage, expected, record):
    """Positive result is SIMULATED only, never actor authentication/real QA."""
    blocked = {"outcome": "BLOCKED", "formal_approval": False, "authenticated": False}
    try:
        role = {"implementation": "ryan", "review": "dwight", "merge": "michael", "qa": "pam"}[stage]
        require(set(expected) == {"head", "base", "test_merge", "merged", "session", "pane", "operation", "token", "artifact", "fingerprint", "source_hash"})
        require(all(type(expected[key]) is str and re.fullmatch(r"[a-f0-9]{40}", expected[key]) for key in ("head", "base", "test_merge", "merged")))
        require(all(mock_id(expected[key]) for key in ("session", "pane", "artifact")))
        require(all(type(expected[key]) is str and re.fullmatch(r"[a-f0-9]{64}", expected[key]) for key in ("operation", "token", "fingerprint", "source_hash")))
        final = record["final"]
        require(final["kind"] == "final" and final["role"] == role)
        require(all(final[key] == expected[key] for key in ("session", "pane", "operation", "token", "artifact", "head")))
        require(record["source"] == "synthetic")
        require(record["fingerprint"] == expected["fingerprint"] and record["source_hash"] == expected["source_hash"])
        if record["verdict"] == "FAIL":
            return {**blocked, "outcome": "FAIL"}
        require(record["verdict"] == "PASS")
        require(all(record[key] == expected[key] for key in ("head", "base", "test_merge")))
        require(record["review"] in {"COMMENT", "APPROVE"} and record["technical"] == "PASS")
        checks = record["checks"]
        require(set(checks) == {"lint", "typecheck", "tests", "build"})
        for check in checks.values():
            if check.get("conclusion") == "failure":
                return {**blocked, "outcome": "FAIL"}
            require(check == {"status": "completed", "conclusion": "success", "head": expected["head"], "base": expected["base"], "test_merge": expected["test_merge"]})
        if stage in {"merge", "qa"}:
            require(record["merged"] == expected["merged"] and record["main"] == expected["merged"])
        if stage == "qa":
            require(record["tested"] == expected["merged"] and record["qa_role"] == "pam")
        return {"outcome": "SIMULATED_PASS", "formal_approval": False, "authenticated": False}
    except Exception:
        return blocked


def revocation_outcome(observation):
    """Synthetic auth-denial predicate only; never an external revocation verdict."""
    blocked = {"outcome": "BLOCKED", "external": "BLOCKED_UNEXECUTED", "retry": False, "authenticated": False}
    if type(observation) is not dict or set(observation) != {"source", "provider", "prior_protected_read", "read_status", "write_status", "final"}:
        return blocked
    if observation["source"] != "synthetic" or observation["provider"] not in {"github-installation", "jira-oauth"}:
        return blocked
    if observation["prior_protected_read"] is not True or observation["final"] is not True or type(observation["read_status"]) is not int or type(observation["write_status"]) is not int:
        return blocked
    if observation["read_status"] != 401 or observation["write_status"] != 401:
        return blocked
    return {**blocked, "outcome": "SIMULATED_AUTH_DENIED"}


def reconcile(snapshot, persisted):
    """Union reconciliation; no delta baseline, mutation, dispatch or side effects."""
    require(type(snapshot) is dict and set(snapshot) == {"complete", "issues"} and snapshot["complete"] is True, "snapshot-incomplete")
    rows = snapshot["issues"]
    require(type(rows) is dict and type(persisted) is dict, "snapshot-invalid")
    for issue, row in rows.items():
        require(mock_id(issue) and type(row) is dict and set(row) == {"stage", "dependencies", "fingerprint", "outcome"}, "snapshot-invalid")
        require(row["stage"] in {"implementation", "review", "qa", "approved", "human", "deployment"}, "snapshot-invalid")
        require(type(row["dependencies"]) is list and all(mock_id(item) for item in row["dependencies"]), "snapshot-invalid")
        require(type(row["fingerprint"]) is str and re.fullmatch(r"[a-f0-9]{64}", row["fingerprint"]), "snapshot-invalid")
        require(row["outcome"] in {"PENDING", "PASS", "FAIL", "BLOCKED"}, "snapshot-invalid")
    def dependency_blocked(issue, visiting):
        if issue in visiting or issue not in rows:
            return True
        row = rows[issue]
        return row["outcome"] in {"FAIL", "BLOCKED"} or any(dep not in rows or rows[dep]["outcome"] != "PASS" or dependency_blocked(dep, visiting | {issue}) for dep in row["dependencies"])
    result = {}
    for issue in sorted(set(rows) | set(persisted)):
        if issue not in rows:
            result[issue] = {"outcome": "BLOCKED", "reason": "missing-snapshot"}
            continue
        row, previous = rows[issue], persisted.get(issue)
        reason = None
        if previous and previous["state"] in {"CLAIMED", "INFLIGHT", "UNKNOWN"}:
            reason = "uncertain-operation"
        elif previous and previous["state"] in {"COMPLETED", "FAILED"} and previous.get("fingerprint") == row["fingerprint"]:
            reason = "existing-completion"
        elif row["stage"] in {"approved", "human", "deployment"}:
            reason = "protected-gate"
        elif dependency_blocked(issue, set()):
            reason = "dependency"
        result[issue] = {"outcome": "BLOCKED", "reason": reason} if reason else {"outcome": "DRY_RUN", "stage": row["stage"], "fingerprint": row["fingerprint"]}
    return result


def dependency_fingerprint(snapshot, issue):
    """Bind only this issue's dependency closure, never unrelated issues."""
    rows, closure, pending = snapshot["issues"], {}, [issue]
    while pending:
        current = pending.pop()
        if current in closure:
            continue
        closure[current] = rows.get(current)
        if current in rows:
            pending.extend(rows[current]["dependencies"])
    return digest(closure)
