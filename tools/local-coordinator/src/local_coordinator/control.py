"""Explicit mock-only facade. No CLI, listener, provider client or scheduler."""
import json
import re
import threading
import time
from hashlib import sha256
from .core import Blocked, MockClock, SECOND, DAY, GIB, canonical, clock_verdict, completion, containment_plan, credential_deadline, dependency_fingerprint, digest, mock_id, reconcile, require, reservation_fits, stamp
from .journal import Crash, Journal, Sandbox, read_only
from .verifier import source_digest, verify_stop


class StopNeeded(Blocked):
    pass


class RecordingSink:
    """Concrete fake only; cannot be replaced with a callable/live adapter."""
    __slots__ = ("__initiations", "__reads", "drain_ns", "confirmed")

    def __init__(self):
        self.__initiations = ()
        self.__reads = ()
        self.drain_ns = 0
        self.confirmed = True

    @property
    def initiations(self):
        return self.__initiations

    @property
    def reads(self):
        return self.__reads

    @property
    def restore_calls(self):
        return 0

    @property
    def dispatch_calls(self):
        return 0

    def _initiate(self, fence):
        require(type(fence) is tuple, "sink-record-invalid")
        self.__initiations += (fence,)

    def _read(self, reference):
        require(mock_id(reference), "sink-record-invalid")
        self.__reads += (reference,)


def scope_valid(scope):
    require(type(scope) is dict and set(scope) == {"fixture", "source", "policy", "config", "caller", "session", "resources", "issues", "runs", "credential_refs"}, "scope-invalid")
    require(all(mock_id(scope[key]) for key in ("fixture", "caller", "session")), "scope-invalid")
    require(all(type(scope[key]) is str and re.fullmatch(r"[a-f0-9]{40}|[a-f0-9]{64}", scope[key]) for key in ("source", "policy", "config")), "scope-invalid")
    resources = scope["resources"]
    require(type(resources) is dict and set(resources) == {"repo", "actions", "workflows", "jira", "principals", "token-store", "resources"}, "resource-scope-invalid")
    require(all(type(values) is list and values and all(mock_id(item) for item in values) for values in resources.values()), "resource-scope-invalid")
    require(all(type(scope[key]) is list and scope[key] and len(scope[key]) == len(set(scope[key])) and all(mock_id(item) for item in scope[key]) for key in ("issues", "runs", "credential_refs")), "scope-invalid")


def audit_id(value):
    value = digest(value)[:32]
    return "-".join((value[:8], value[8:12], value[12:16], value[16:20], value[20:]))


def request_valid(request):
    require(type(request) is str and re.fullmatch(r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}", request), "request-invalid")


def initial_state(scope, start, clock):
    scope_valid(scope)
    require(type(clock) is MockClock and clock.suspend_supported is True and type(start) is int and 0 <= start <= clock.utc < start + 14 * DAY, "clock-invalid")
    return {"control": {"state": "DISABLED", "scope": json.loads(canonical(scope)), "start": start, "deadline": start + 14 * DAY, "start_utc": stamp(start), "deadline_utc": stamp(start + 14 * DAY), "generation": 1, "epoch": 0, "boot": clock.boot, "session": None, "anchor_utc": clock.utc, "anchor_mono": clock.mono, "last_mono": clock.mono, "high_water": clock.utc, "reason": None}, "snapshot": None, "issues": {}, "operations": {}, "reservations": {}, "runs": {}, "minutes": {}, "storage": 0, "handles": {}, "stops": {}}


class MockControl:
    def __init__(self, journal, scope, clock, sink):
        require(type(journal) is Journal and type(clock) is MockClock and type(sink) is RecordingSink, "concrete-mocks-required")
        scope_valid(scope)
        require(scope["source"] == source_digest(), "source-binding-mismatch")
        require(journal.body["control"]["scope"] == scope, "scope-mismatch")
        self._journal, self._scope, self.clock, self.sink = journal, json.loads(canonical(scope)), clock, sink
        self._enabled = threading.Event()  # Every new process/object starts CLOSED.
        self._stop_requested = threading.Event()
        self._lease = None
        self._gate = journal.gate
        self._stop_thread = None
        self.stop_fault = None

    @classmethod
    def initialize(cls, sandbox, scope, start, clock, sink):
        return cls(Journal(sandbox, initial_state(scope, start, clock)), scope, clock, sink)

    @classmethod
    def reopen(cls, sandbox, scope, clock, sink, retained_digest):
        require(type(retained_digest) is str and re.fullmatch(r"[a-f0-9]{64}", retained_digest), "retained-digest-required")
        return cls(Journal(sandbox, expected=retained_digest), scope, clock, sink)

    @property
    def enabled(self):
        return self._enabled.is_set() and not self._stop_requested.is_set()

    def _check_time(self, control, body):
        deadline = min([control["deadline"]] + [row["deadline"] for row in body["handles"].values() if not row["revoked"]])
        try:
            verdict = clock_verdict(control, self.clock, deadline)
        except Blocked:
            self._enabled.clear()
            raise StopNeeded("clock") from None
        if verdict == "EXPIRED":
            self._enabled.clear()
            raise StopNeeded("expired")

    def _guard(self, body):
        require(self.enabled, "disabled")
        control = body["control"]
        require(control["state"] == "ARMED_MOCK" and control["session"] == self._scope["session"], "lease-invalid")
        require(not self._stop_requested.is_set() and self._lease == (control["generation"], control["epoch"], control["session"], control["boot"]), "lease-invalid")
        self._check_time(control, body)
        control["high_water"] = self.clock.utc
        control["last_mono"] = self.clock.mono

    def _normal(self, event, action):
        require(self.enabled, "disabled")
        try:
            with self._gate:
                require(self.enabled, "disabled")
                with self._journal.transaction(event) as body:
                    self._guard(body)
                    return action(body)
        except StopNeeded as error:
            self.halt("00000000-0000-4000-8000-000000000000", self._scope["caller"], str(error))
            raise Blocked("job-timeout-blocked" if str(error) == "recovery" else "expired-or-clock-blocked") from None
        except Blocked as error:
            # Issue-local rejection is not a shared-journal/clock fault. It must
            # not shut down an unrelated dependency closure's eligible work.
            if str(error) not in {"eligible-plan-required", "plan-input-mismatch", "plan-dependency-blocked", "stale-fence", "stale-snapshot", "effect-dependency-blocked", "effect-not-eligible", "completion-not-eligible", "completion-conflict", "claim-replay-conflict"}:
                self._enabled.clear()
            raise
        except BaseException:
            self._enabled.clear()
            raise

    def arm_mock(self, caller):
        require(caller == self._scope["caller"], "caller-denied")
        require(not self.enabled, "already-armed")
        require(not self._stop_requested.is_set(), "terminal-disabled")
        try:
            with self._gate:
                with self._journal.transaction("explicit-mock-admission") as body:
                    control = body["control"]
                    require(control["state"] in {"DISABLED", "ARMED_MOCK"}, "terminal-disabled")
                    require(control["epoch"] < 2 ** 63 - 1 and control["generation"] < 2 ** 63 - 1, "epoch-overflow")
                    self._check_time(control, body)
                    require(control["scope"] == self._scope, "scope-mismatch")
                    if control["session"] is not None:
                        control["generation"] += 1
                        control["epoch"] += 1
                        for row in body["operations"].values():
                            if row["state"] in {"CLAIMED", "INFLIGHT"}:
                                row["state"] = "UNKNOWN"
                    control.update(state="ARMED_MOCK", session=self._scope["session"], high_water=self.clock.utc, last_mono=self.clock.mono)
                require(not self._stop_requested.is_set(), "stop-requested")
                c = self._journal.body["control"]
                self._lease = (c["generation"], c["epoch"], c["session"], c["boot"])
                self._enabled.set()
        except StopNeeded as error:
            self._enabled.clear()
            self.halt("00000000-0000-4000-8000-000000000000", caller, str(error))
            raise Blocked("expired-or-clock-blocked") from None
        except BaseException:
            self._enabled.clear()
            raise

    def plan(self, snapshot):
        try:
            snapshot = json.loads(canonical(snapshot))
            require(type(snapshot) is dict and type(snapshot.get("issues")) is dict and set(snapshot["issues"]) <= set(self._scope["issues"]), "snapshot-scope-mismatch")
        except (Blocked, ValueError, TypeError):
            self._enabled.clear()
            raise Blocked("snapshot-invalid") from None
        if not self.enabled:
            return {"mode": "DISABLED_DRY_RUN", "plans": reconcile(snapshot, self._journal.body["issues"])}
        def record(body):
            plans = reconcile(snapshot, body["issues"])
            body["snapshot"] = snapshot
            for issue, plan in plans.items():
                if issue in body["issues"]:
                    body["issues"][issue]["missing_snapshot"] = issue not in snapshot["issues"]
                    body["issues"][issue]["eligible"] = False
                    body["issues"][issue]["rejection"] = plan.get("reason")
                    if issue in snapshot["issues"]:
                        body["issues"][issue]["observed_fingerprint"] = snapshot["issues"][issue]["fingerprint"]
                if plan["outcome"] != "DRY_RUN":
                    continue
                require(issue in body["issues"] or len(body["issues"]) < 25, "issue-capacity")
                previous = body["issues"].get(issue)
                if previous and previous["state"] in {"CLAIMED", "INFLIGHT", "UNKNOWN"}:
                    continue
                body["issues"][issue] = {**plan, "state": "PLANNED", "observed_fingerprint": plan["fingerprint"], "missing_snapshot": False, "eligible": True, "plan_lease": list(self._lease), "rejection": None}
            return {"mode": "MOCK_ONLY", "plans": plans}
        return self._normal("dry-run-reconciliation", record)

    def claim(self, issue, stage, fingerprint, run, records=1, storage=4096):
        require(all(mock_id(value) for value in (issue, run)) and stage in {"implementation", "review", "qa"}, "claim-invalid")
        require(issue in self._scope["issues"] and run in self._scope["runs"], "claim-scope-mismatch")
        require(type(fingerprint) is str and re.fullmatch(r"[a-f0-9]{64}", fingerprint), "claim-invalid")
        require(type(records) is int and records >= 0 and type(storage) is int and storage >= 0, "reservation-invalid")
        operation = digest([self._scope["fixture"], issue, stage, fingerprint])
        def action(body):
            c = body["control"]
            if operation in body["operations"]:
                reservation = body["reservations"][operation]
                require(reservation["run"] == run and reservation["records"] == records and reservation["storage"] == storage, "claim-replay-conflict")
                return tuple(body["operations"][operation]["fence"])
            plan = body["issues"].get(issue)
            require(plan is not None and plan["state"] == "PLANNED" and plan.get("eligible") is True and plan.get("plan_lease") == list(self._lease), "eligible-plan-required")
            require(plan["stage"] == stage and plan["fingerprint"] == fingerprint, "plan-input-mismatch")
            require(body["snapshot"] is not None and reconcile(body["snapshot"], body["issues"])[issue]["outcome"] == "DRY_RUN", "plan-dependency-blocked")
            require(not any(row["issue"] == issue and row["state"] in {"CLAIMED", "INFLIGHT", "UNKNOWN"} for row in body["operations"].values()), "uncertain-operation")
            require(not any(row["active"] for row in body["reservations"].values()), "concurrent-job-capacity")
            month = stamp(self.clock.utc)[:7]
            used = body["runs"].get(run, 0)
            require(reservation_fits(used + records, len(set(body["issues"]) | {issue}), body["minutes"].get(month, 0) + 30, body["storage"] + storage, 1 + sum(row["active"] for row in body["reservations"].values())), "reservation-capacity")
            require(issue in body["issues"] or len(body["issues"]) < 25, "issue-capacity")
            body["runs"][run] = used + records
            body["minutes"][month] = body["minutes"].get(month, 0) + 30
            body["storage"] += storage
            fence = [self._scope["fixture"], c["generation"], c["epoch"], operation, fingerprint]
            body["reservations"][operation] = {"active": True, "run": run, "records": records, "storage": storage, "timeout": self.clock.mono + 1800 * SECOND}
            body["operations"][operation] = {"issue": issue, "stage": stage, "eligibility_hash": dependency_fingerprint(body["snapshot"], issue), "token": digest([fence, "mock-correlation"]), "state": "CLAIMED", "fence": fence, "attempts": [digest([operation, 1])], "next": self.clock.mono, "observation": None, "evidence": []}
            body["issues"][issue].update(state="CLAIMED", eligible=False)
            return tuple(fence)
        return self._normal("claim-and-reserve", action)

    def _fence(self, body, fence):
        require(type(fence) is tuple and len(fence) == 5, "fence-invalid")
        c = body["control"]
        row = body["operations"].get(fence[3])
        require(row is not None and fence == tuple(row["fence"]) and fence[:3] == (self._scope["fixture"], c["generation"], c["epoch"]), "stale-fence")
        issue = body["issues"][row["issue"]]
        require(not issue.get("missing_snapshot", False) and issue.get("observed_fingerprint", issue["fingerprint"]) == fence[4], "stale-snapshot")
        snapshot = body["snapshot"]
        require(snapshot is not None and row["issue"] in snapshot["issues"] and snapshot["issues"][row["issue"]]["stage"] == row["stage"] and reconcile(snapshot, {})[row["issue"]]["outcome"] == "DRY_RUN", "effect-dependency-blocked")
        require(row["eligibility_hash"] == dependency_fingerprint(snapshot, row["issue"]), "stale-snapshot")
        if self.clock.mono >= body["reservations"][fence[3]]["timeout"]:
            self._enabled.clear()
            raise StopNeeded("recovery")
        return row

    def effect(self, fence):
        def action(body):
            row = self._fence(body, fence)
            require(row["state"] == "CLAIMED" and row.get("failure_at") is None and self.clock.mono >= row["next"], "effect-not-eligible")
            # Validation and initiation are inside the SAME gate/transaction.
            self.sink._initiate(fence)
            row["state"] = "INFLIGHT"
            return {"outcome": "MOCK_INITIATED", "operation": fence[3]}
        return self._normal("mock-effect-initiation", action)

    def finish(self, fence, evidence_ref, expected=None, record=None):
        require(mock_id(evidence_ref), "evidence-invalid")
        def action(body):
            row = self._fence(body, fence)
            require(type(expected) is dict and expected.get("operation") == fence[3] and expected.get("token") == row["token"] and expected.get("fingerprint") == fence[4] and expected.get("session") == self._scope["session"] and expected.get("source_hash") == self._scope["source"], "completion-correlation-invalid")
            current = body["issues"][row["issue"]]
            require(not current.get("missing_snapshot", False) and current.get("observed_fingerprint", current["fingerprint"]) == fence[4], "completion-snapshot-stale")
            evaluation = completion(row["stage"], expected, record)
            require(evaluation["outcome"] != "BLOCKED", "completion-evidence-blocked")
            receipt = digest([expected, record, evidence_ref])
            if row["state"] in {"COMPLETED", "FAILED"}:
                require(row.get("evaluation") == receipt and evidence_ref in row["evidence"], "completion-conflict")
                return {"outcome": "EXISTING_SIMULATED_COMPLETION", "authenticated": False}
            require(row["state"] in {"CLAIMED", "INFLIGHT"}, "completion-not-eligible")
            row["state"] = "COMPLETED" if evaluation["outcome"] == "SIMULATED_PASS" else "FAILED"
            row["evaluation"] = receipt
            if evidence_ref not in row["evidence"]:
                row["evidence"].append(evidence_ref)
            body["issues"][row["issue"]]["state"] = row["state"]
            body["reservations"][fence[3]]["active"] = False
            return {"outcome": "SIMULATED_COMPLETION" if row["state"] == "COMPLETED" else "SIMULATED_FAIL", "authenticated": False}
        return self._normal("mock-completion", action)

    def retry(self, fence, classification, proven_not_sent):
        def action(body):
            row = self._fence(body, fence)
            require(classification == "transient" and proven_not_sent is True and row["state"] == "CLAIMED", "retry-prohibited")
            count = len(row["attempts"])
            require(count < 3, "retry-limit-observation-only")
            delay = (5 if count == 1 else 30) * SECOND
            if row.get("failure_at") is None:
                row["failure_at"] = self.clock.mono
                row["next"] = self.clock.mono + delay
                return {"outcome": "WAIT", "at": row["next"]}
            if self.clock.mono < row["next"]:
                return {"outcome": "WAIT", "at": row["next"]}
            row["attempts"].append(digest([fence[3], count + 1]))
            row["failure_at"] = None
            row["next"] = self.clock.mono
            if len(row["attempts"]) == 3:
                row["observation"] = self.clock.mono + 120 * SECOND
            return {"outcome": "MOCK_RETRY", "attempt": len(row["attempts"])}
        return self._normal("bounded-local-retry", action)

    def handle(self, reference, issued, requested, provider_expiry):
        require(mock_id(reference) and reference in self._scope["credential_refs"], "opaque-reference-required")
        def action(body):
            require(reference not in body["handles"], "no-refresh")
            deadline = credential_deadline(body["control"]["deadline"], issued, requested, provider_expiry)
            require(issued <= self.clock.utc and requested <= self.clock.utc, "credential-time-unknown")
            require(self.clock.utc < deadline, "credential-expired")
            body["handles"][reference] = {"deadline": deadline, "revoked": False}
            return reference
        return self._normal("mock-opaque-handle", action)

    def read_handle(self, reference, fence):
        def action(body):
            self._fence(body, fence)
            require(reference in body["handles"] and not body["handles"][reference]["revoked"], "handle-revoked")
            self.sink._read(reference)
            return {"reference": reference, "secret": False}
        return self._normal("mock-handle-use", action)

    def watchdog(self):
        def check(body):
            if any(row["active"] and self.clock.mono >= row["timeout"] for row in body["reservations"].values()):
                self._enabled.clear()
                raise StopNeeded("recovery")
            return {"outcome": "CURRENT_MOCK_ONLY"}
        return self._normal("injected-watchdog", check)

    def invoke(self, command, options, *, candidate=None, selected=None, snapshot_receipt=None):
        """Mock command shape only, not a listener, CLI or arbitrary method executor."""
        require(type(options) is dict and options.get("fixture_root") == str(self._journal.sandbox.root) and options.get("fixture_id") == self._scope["fixture"] and options.get("caller") == self._scope["caller"], "control-scope-denied")
        if command == "halt":
            require(set(options) == {"fixture_root", "fixture_id", "caller", "request_id", "operator", "reason"}, "control-shape-invalid")
            return self.halt(options["request_id"], options["caller"], options["reason"], options["operator"])
        if command == "inspect":
            require(set(options) == {"fixture_root", "fixture_id", "caller", "read_only", "expect_disabled"} and options["read_only"] is True and options["expect_disabled"] is True, "control-shape-invalid")
            return self.inspect()
        if command == "snapshot":
            require(set(options) == {"fixture_root", "fixture_id", "caller", "request_id"}, "control-shape-invalid")
            request = options["request_id"]
            request_valid(request)
            require(type(candidate) is Sandbox, "explicit-candidate-required")
            identity = digest([command, self._scope, request, str(candidate.root)])
            with self._gate:
                prior = self._command_prior(request, identity)
                if prior is not None:
                    require(prior.get("snapshot") is not None, "snapshot-request-unconfirmed")
                    saved, tail = read_only(candidate.root / "journal.sqlite3", prior["tail"])
                    require(digest([tail, saved]) == prior["snapshot"], "snapshot-digest-mismatch")
                    return prior
                with self._journal.transaction("snapshot-command-intent") as body:
                    body["stops"][request] = {"identity": identity, "receipt": {"outcome": "BLOCKED", "reason": "snapshot-unconfirmed"}}
                receipt = self.snapshot(candidate, self._journal.body["control"]["epoch"], options["caller"])
                with self._journal.transaction("snapshot-command-receipt") as body:
                    body["stops"][request] = {"identity": identity, "receipt": receipt}
                return receipt
        if command == "rollback":
            require(set(options) == {"fixture_root", "fixture_id", "caller", "request_id", "snapshot_id", "expected_epoch"}, "control-shape-invalid")
            request = options["request_id"]
            request_valid(request)
            require(type(candidate) is Sandbox and type(selected) is Sandbox and type(snapshot_receipt) is dict and options["snapshot_id"] == snapshot_receipt.get("snapshot"), "rollback-input-invalid")
            expected_root = self._journal.sandbox.root.parent / ("coordinator-recovery-" + digest([str(self._journal.sandbox.root), request]))
            require(candidate.root == expected_root, "request-candidate-binding-required")
            identity = digest([command, self._scope, options, str(selected.root), str(candidate.root), snapshot_receipt])
            with self._gate:
                require(request not in self._journal.body["stops"], "conflicting-request")
                candidate.check()
                if (candidate.root / "journal.sqlite3").exists():
                    body, tail = read_only(candidate.root / "journal.sqlite3")
                    prior = body["stops"].get(request)
                    require(prior is not None and prior["identity"] == identity and prior["receipt"]["outcome"] == "ROLLBACK_COMMAND_COMPLETE", "rollback-request-unconfirmed")
                    row = body["stops"][request]["receipt"]
                    # Completed candidates are immutable command artifacts.
                    db_body, current_tail = read_only(self._journal.path, self._journal.tail)
                    require(row["authoritative"] == current_tail and db_body["control"]["epoch"] == options["expected_epoch"], "rollback-request-stale")
                    return {"tail": tail, "selected": row["selected"], "authoritative": row["authoritative"], "enabled": False}
                return self.rollback(selected, candidate, options["expected_epoch"], snapshot_receipt, options["caller"], command=(request, identity))
        if command == "revoke-plan":
            require(set(options) == {"fixture_root", "fixture_id", "caller", "request_id", "credential_ref", "provider"}, "control-shape-invalid")
            return self.revoke_plan(options["request_id"], options["caller"], options["credential_ref"], options["provider"])
        raise Blocked("control-command-denied")

    def _command_prior(self, request, identity):
        self._journal.sandbox.check()
        body, _ = read_only(self._journal.path, self._journal.tail)
        require(not self.enabled, "command-while-enabled")
        prior = body["stops"].get(request)
        if prior is not None:
            require(prior["identity"] == identity, "conflicting-request")
            return json.loads(canonical(prior["receipt"]))
        # Rollback receipts live in their deterministic NEW candidate, preserving
        # the authoritative original byte-for-byte. Check it for cross-command reuse.
        root = self._journal.sandbox.root.parent / ("coordinator-recovery-" + digest([str(self._journal.sandbox.root), request]))
        if root.exists():
            require(not root.is_symlink() and not (root / "journal.sqlite3").exists(), "conflicting-request")
        return None

    def halt(self, request, caller, reason="manual", operator="roy"):
        require(caller == self._scope["caller"] and operator == "roy" and reason in {"manual", "expired", "clock", "storage", "recovery"}, "caller-denied")
        request_valid(request)
        self._stop_requested.set()
        self._enabled.clear()  # Never gated on quota, journal lock or budget.
        self._lease = None
        start_real, start_mock = time.monotonic_ns(), self.clock.mono
        result = {"outcome": "BLOCKED", "reason": "stop-unconfirmed", "exit": 3}
        identity = digest([self._scope["fixture"], request, caller, reason, operator])
        def elapsed():
            current = self.clock.mono
            if type(start_mock) is not int or type(current) is not int or current < start_mock:
                return 6 * SECOND
            return max(time.monotonic_ns() - start_real, current - start_mock)
        def remaining():
            return max(0, 5 * SECOND - elapsed())
        def stop():
            acquired = self._gate.acquire(timeout=remaining() / SECOND)
            if not acquired:
                return
            try:
                self._command_prior(request, identity)
                with self._journal.transaction("disable-linearization") as body:
                    prior = body["stops"].get(request)
                    if prior is not None:
                        require(prior["identity"] == identity, "conflicting-request")
                        require(prior["receipt"].get("outcome") == "QUIESCENCE_RECORDED" and body["control"]["epoch"] >= prior["receipt"]["epoch"], "stop-unconfirmed")
                        require(self.inspect()["verified"] and "verification" in prior["receipt"], "stop-unconfirmed")
                        result.update({**prior["receipt"], "outcome": "LOCAL_STOPPED", "exit": 0})
                        return
                    c = body["control"]
                    was_expired = c["state"] == "EXPIRED"
                    was_stopped = c["state"] == "STOPPED"
                    require(c["epoch"] < 2 ** 63 - 1, "epoch-overflow")
                    c.update(state="EXPIRED" if was_expired else "STOPPED" if was_stopped else "STOPPING", epoch=c["epoch"] + 1, reason=reason)
                    for row in body["operations"].values():
                        if row["state"] in {"CLAIMED", "INFLIGHT"}:
                            row["state"] = "UNKNOWN" if row["state"] == "INFLIGHT" else "CANCELLED"
                    for reservation in body["reservations"].values():
                        reservation["active"] = False  # Charges are NEVER refunded/reset.
                    for issue in body["issues"].values():
                        issue["eligible"] = False
                        if issue["state"] in {"PLANNED", "CLAIMED", "INFLIGHT"}:
                            issue["state"] = "CANCELLED"
                    body["stops"][request] = {"identity": identity, "receipt": dict(result)}
                # Durable disable has committed/fsynced BEFORE drain/revoke planning.
                if self.stop_fault == "before-cancellation":
                    raise Crash()
                if time.monotonic_ns() - start_real > 5 * SECOND:
                    return
                if self.sink.drain_ns:
                    self.clock.advance(self.sink.drain_ns)
                if self.stop_fault == "after-cancellation":
                    raise Crash()
                if self.sink.confirmed is not True or elapsed() > 5 * SECOND:
                    return
                with self._journal.transaction("stop-evidence") as body:
                    for handle in body["handles"].values():
                        handle.update(revoked=True, revoked_epoch=body["control"]["epoch"], reason="local-stop")
                    body["control"]["state"] = "EXPIRED" if was_expired or reason == "expired" and not was_stopped else "STOPPED"
                    receipt = {"outcome": "QUIESCENCE_RECORDED", "epoch": body["control"]["epoch"], "request": request, "scope_plan": containment_plan(body["control"], body["handles"]), "external": "BLOCKED_UNEXECUTED", "exit": 3}
                    body["stops"][request]["receipt"] = receipt
                verdict = self.inspect(expect_disabled=True)
                require(verdict["verified"] is True, "stop-verification-failed")
                if self.stop_fault == "after-verifier":
                    raise Crash()
                with self._journal.transaction("stop-verifier-receipt") as body:
                    receipt = {**receipt, "verification": verdict}
                    body["stops"][request]["receipt"] = receipt
                if elapsed() <= 5 * SECOND:
                    result.update({**receipt, "outcome": "LOCAL_STOPPED", "exit": 0})
            except BaseException:
                result.update(outcome="BLOCKED", reason="stop-evidence-incomplete", exit=3)
            finally:
                self._gate.release()
        if self._stop_thread is not None and self._stop_thread.is_alive():
            return result
        self._stop_thread = threading.Thread(target=stop, name="disposable-stop-evidence", daemon=True)
        self._stop_thread.start()
        # The injected clock supplies deterministic phase costs; real time also
        # bounds the wait if an actual local lock/fsync stalls. Equality may finish
        # zero-cost mock evidence phases, but never extends the real-time bound.
        self._stop_thread.join(max(0, 5 * SECOND - (time.monotonic_ns() - start_real)) / SECOND)
        if self._stop_thread.is_alive() or elapsed() > 5 * SECOND:
            return {"outcome": "BLOCKED", "reason": "stop-timeout", "exit": 3}
        return result

    def inspect(self, expect_disabled=True):
        self._journal.sandbox.check()
        require(expect_disabled is True and not self.enabled, "verifier-admission-open")
        body, before = read_only(self._journal.path, self._journal.tail)
        sink_before = digest([self.sink.initiations, self.sink.reads, self.sink.restore_calls, self.sink.dispatch_calls])
        denied, reason = False, None
        try:
            self.claim(self._scope["issues"][0], "review", digest("denied-admission-probe"), self._scope["runs"][0])
        except Blocked as error:
            denied, reason = True, str(error)
        _, after = read_only(self._journal.path, self._journal.tail)
        probe = {"denied": denied, "reason": reason, "before": before, "after": after, "sink_before": sink_before, "sink_after": digest([self.sink.initiations, self.sink.reads, self.sink.restore_calls, self.sink.dispatch_calls])}
        return verify_stop(self._journal.sandbox, after, self._scope, body["control"]["epoch"], probe)

    def revoke_plan(self, request, caller, credential_ref=None, provider="token-store"):
        request_valid(request)
        require(not self.enabled and caller == self._scope["caller"] and credential_ref in self._scope["credential_refs"] and provider in {"github-installation", "jira-oauth", "token-store"}, "revocation-denied")
        identity = digest(["revoke-plan", self._scope, request, credential_ref, provider])
        with self._gate:
            prior = self._command_prior(request, identity)
            if prior is not None:
                return prior
            require(self.inspect()["verified"], "disable-not-verified")
            with self._journal.transaction("mock-revocation-audit") as body:
                require(body["control"]["state"] in {"STOPPED", "EXPIRED"}, "disable-not-verified")
                require(credential_ref in body["handles"], "handle-unknown")
                for row in body["handles"].values():
                    row["revoked"] = True
                receipt = {"request": request, "references": [credential_ref], "provider": provider, "operator": "roy", "start": body["control"]["start_utc"], "deadline": body["control"]["deadline_utc"], "epoch": body["control"]["epoch"], "scope": self._scope["resources"], "operations": {"repo": "disable-actions-and-write-access", "actions": "cancel-recorded-runs", "workflows": "disable-all-fixture-workflows", "jira": "remove-fixture-project-write-membership", "principals": "revoke-dedicated-grants", "token-store": "invalidate-local-handles", "resources": "deny-fixture-writes"}, "provider_operations": "BLOCKED_UNEXECUTED", "secret": False}
                body["stops"][request] = {"identity": identity, "receipt": receipt}
                return receipt

    def snapshot(self, candidate, expected_epoch, caller=None):
        require(caller == self._scope["caller"], "caller-denied")
        require(type(candidate) is Sandbox and candidate.root.parent == self._journal.sandbox.root.parent, "candidate-scope-mismatch")
        require(not self.enabled, "snapshot-while-enabled")
        with self._gate:
            body = self._journal.body
            require(body["control"]["state"] in {"DISABLED", "STOPPED", "EXPIRED"} and body["control"]["epoch"] == expected_epoch, "snapshot-epoch-mismatch")
            receipt = self._journal.backup(candidate)
            with self._journal.transaction("verified-snapshot-audit") as state:
                state["stops"][audit_id(["snapshot", receipt["snapshot"]])] = {"identity": receipt["snapshot"], "receipt": {"outcome": "SNAPSHOT_VERIFIED", **receipt}}
            return receipt

    def rollback(self, selected, candidate, expected_epoch, snapshot_receipt, caller=None, command=None):
        require(caller == self._scope["caller"], "caller-denied")
        require(not self.enabled and type(selected) is Sandbox and type(candidate) is Sandbox, "rollback-disabled-required")
        require(selected.root.parent == self._journal.sandbox.root.parent and candidate.root.parent == self._journal.sandbox.root.parent and not (candidate.root / "journal.sqlite3").exists(), "candidate-scope-mismatch")
        try:
            with self._gate:
                current = self._journal.body
                require(current["control"]["state"] in {"DISABLED", "STOPPED", "EXPIRED"} and current["control"]["epoch"] == expected_epoch, "rollback-epoch-mismatch")
                require(type(snapshot_receipt) is dict and set(snapshot_receipt) == {"snapshot", "tail", "file", "file_hash", "code", "config", "state", "evidence"}, "snapshot-receipt-invalid")
                path = selected.root / "journal.sqlite3"
                saved, tail = read_only(path, snapshot_receipt["tail"])
                require(snapshot_receipt["file"] == path.name and sha256(path.read_bytes()).hexdigest() == snapshot_receipt["file_hash"] and digest([tail, saved]) == snapshot_receipt["snapshot"], "snapshot-digest-mismatch")
                require(snapshot_receipt["code"] == saved["control"]["scope"]["source"] and snapshot_receipt["config"] == saved["control"]["scope"]["config"] and snapshot_receipt["state"] == digest(saved) and snapshot_receipt["evidence"] == tail, "snapshot-metadata-mismatch")
                registered = current["stops"].get(audit_id(["snapshot", snapshot_receipt["snapshot"]]))
                require(registered is not None and registered["receipt"] == {"outcome": "SNAPSHOT_VERIFIED", **snapshot_receipt}, "snapshot-receipt-unregistered")
                require(saved["control"]["scope"] == current["control"]["scope"] and saved["control"]["start"] == current["control"]["start"] and saved["control"]["deadline"] == current["control"]["deadline"], "rollback-incompatible")
                require(all(row["state"] not in {"UNKNOWN", "CLAIMED", "INFLIGHT"} for state in (saved, current) for row in state["operations"].values()), "rollback-ambiguous-claim")
                require(saved["operations"].keys() <= current["operations"].keys() and all(len(saved["operations"][key]["attempts"]) <= len(current["operations"][key]["attempts"]) for key in saved["operations"]), "rollback-ambiguous")
                receipt = self._journal.restore_union(selected, candidate, tail, command)
                restored, _ = read_only(candidate.root / "journal.sqlite3", receipt["tail"])
                require(restored["control"]["state"] in {"DISABLED", "STOPPED", "EXPIRED"}, "rollback-unverified")
                return receipt
        except BaseException:
            self._enabled.clear()
            for root in (self._journal.sandbox, candidate):
                try:
                    root.quarantine()
                except OSError:
                    pass
            raise Blocked("rollback-quarantined") from None
