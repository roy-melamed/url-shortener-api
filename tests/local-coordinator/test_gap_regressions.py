"""Negative acceptance probes for the local gaps; no external adapters or accounts."""
import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch
from local_coordinator.core import Blocked, DAY, SECOND, digest, revocation_outcome, valid_format
from local_coordinator.control import MockControl
from local_coordinator.journal import Journal, Sandbox, read_only
from local_coordinator.verifier import verify_stop
from fixtures import Fixture, REQUEST, START, issue

SNAPSHOT_REQUEST = "00000000-0000-4000-8000-000000000002"
ROLLBACK_REQUEST = "00000000-0000-4000-8000-000000000003"
REVOKE_REQUEST = "00000000-0000-4000-8000-000000000004"


def options(f, **values):
    return {"fixture_root": str(f.sandbox.root), "fixture_id": f.scope["fixture"], "caller": f.scope["caller"], **values}


class GapRegressionTests(unittest.TestCase):
    def test_retry_wait_cannot_be_bypassed_by_direct_effect_or_reservation_replay(self):
        f = Fixture()
        try:
            f.arm()
            fence = f.claim()
            self.assertEqual(f.control.retry(fence, "transient", True)["outcome"], "WAIT")
            with self.assertRaisesRegex(Blocked, "effect-not-eligible"):
                f.control.effect(fence)
            for run, records, storage in (("mock-other-run", 1, 4096), ("mock-run", 2, 4096), ("mock-run", 1, 0)):
                with self.assertRaisesRegex(Blocked, "replay-conflict"):
                    f.control.claim("mock-issue", "review", digest("mock-issue"), run, records, storage)
            self.assertEqual(f.sink.initiations, ())
            self.assertEqual(f.control._journal.body["runs"], {"mock-run": 1})
            f.clock.advance(5 * SECOND)
            f.control.retry(fence, "transient", True)
            f.control.effect(fence)
            self.assertEqual(f.sink.initiations, (fence,))
        finally:
            f.close()

    def test_dependency_hash_change_invalidates_old_fence_but_unrelated_change_does_not(self):
        f = Fixture()
        try:
            f.arm()
            rows = {"mock-a": issue("review", ["mock-b"], fingerprint=digest("a")), "mock-b": issue(outcome="PASS"), "mock-other": issue()}
            f.control.plan({"complete": True, "issues": rows})
            fence = f.control.claim("mock-a", "review", digest("a"), "mock-run")
            rows["mock-other"]["fingerprint"] = digest("unrelated-change")
            f.control.plan({"complete": True, "issues": rows})
            # No effect is initiated by the eligibility probe itself.
            self.assertEqual(f.control._fence(f.control._journal.body, fence)["state"], "CLAIMED")
            rows["mock-b"]["fingerprint"] = digest("dependency-change")
            f.control.plan({"complete": True, "issues": rows})
            with self.assertRaisesRegex(Blocked, "stale-snapshot"):
                f.control.effect(fence)
            self.assertEqual(f.sink.initiations, ())
        finally:
            f.close()

    def test_issue_local_rejection_does_not_close_an_unrelated_eligible_plan(self):
        f = Fixture()
        try:
            f.arm()
            rows = {"mock-a": issue(dependencies=["mock-b"]), "mock-b": issue(outcome="BLOCKED"), "mock-other": issue("review", fingerprint=digest("other"))}
            f.control.plan({"complete": True, "issues": rows})
            before = f.control._journal.tail
            with self.assertRaises(Blocked):
                f.control.claim("mock-a", "implementation", rows["mock-a"]["fingerprint"], "mock-run")
            self.assertTrue(f.control.enabled)
            self.assertEqual(before, f.control._journal.tail)
            fence = f.control.claim("mock-other", "review", digest("other"), "mock-run")
            f.control.effect(fence)
            self.assertEqual(f.sink.initiations, (fence,))
        finally:
            f.close()

    def test_bad_command_shapes_and_state_acl_do_not_mutate_unrelated_fixture(self):
        f, other = Fixture(), Fixture()
        try:
            other_tail = other.control._journal.tail
            for command, extra in (("snapshot", {"request_id": "not-a-uuid"}), ("inspect", {"read_only": False, "expect_disabled": True}), ("rollback", {"request_id": ROLLBACK_REQUEST, "snapshot_id": "unknown", "expected_epoch": 0}), ("revoke-plan", {"request_id": REVOKE_REQUEST, "credential_ref": "mock-unknown", "provider": "jira-oauth"})):
                with self.assertRaises(Blocked):
                    f.control.invoke(command, options(f, **extra))
            self.assertEqual(other_tail, other.control._journal.tail)
            f.control._journal.path.chmod(0o644)
            with self.assertRaisesRegex(Blocked, "acl"):
                f.control._journal.sandbox.check()
            self.assertEqual(other_tail, other.control._journal.tail)
        finally:
            f.close()
            other.close()

    def test_terminal_stop_requests_replay_stably_and_credentials_cannot_gain_future_lifetime(self):
        f = Fixture()
        try:
            f.arm()
            first = f.control.halt(REQUEST, f.scope["caller"])
            second = f.control.halt(SNAPSHOT_REQUEST, f.scope["caller"], "expired")
            self.assertEqual(second["outcome"], "LOCAL_STOPPED")
            self.assertEqual(f.control._journal.body["control"]["state"], "STOPPED")
            self.assertEqual(first, f.control.halt(REQUEST, f.scope["caller"]))
        finally:
            f.close()
        for issued, requested, provider in ((None, START, START + DAY), (START, START, None), (START + SECOND, START + SECOND, START + DAY)):
            f = Fixture()
            try:
                f.arm()
                with self.assertRaises(Blocked):
                    f.control.handle("mock-handle", issued, requested, provider)
                self.assertFalse(f.control.enabled)
                self.assertEqual(f.control._journal.body["handles"], {})
            finally:
                f.close()

    def test_markdown_fences_fail_closed_and_injected_watchdog_has_one_second_cadence(self):
        for content in ("```python\n~~~\n", "````python\n```\n", "~~~text\n```\n", "```bad`info\n```\n"):
            self.assertFalse(valid_format(content))
        self.assertTrue(valid_format("````python\n```\n````\n"))
        self.assertTrue(valid_format("~~~text\ncontent\n~~~\n"))
        f = Fixture()
        try:
            f.arm()
            for _ in range(3):
                before = f.clock.mono
                f.clock.advance(SECOND)
                f.control.watchdog()
                self.assertLessEqual(f.clock.mono - before, SECOND)
        finally:
            f.close()

    def test_claim_requires_persisted_current_plan_and_exact_inputs(self):
        for invalid in ("absent", "disabled-only-plan", "stage", "fingerprint", "restart-lease", "missing", "blocked", "human", "cycle", "failed-dependency"):
            f = Fixture()
            try:
                if invalid == "disabled-only-plan":
                    f.control.plan({"complete": True, "issues": {"mock-a": issue()}})
                f.arm()
                rows = {"mock-a": issue(fingerprint=digest("a"))}
                if invalid not in {"absent", "disabled-only-plan"}:
                    if invalid == "blocked":
                        rows["mock-a"]["outcome"] = "BLOCKED"
                    elif invalid == "human":
                        rows["mock-a"]["stage"] = "human"
                    elif invalid in {"cycle", "failed-dependency"}:
                        rows["mock-a"]["dependencies"] = ["mock-b"]
                        rows["mock-b"] = issue(dependencies=["mock-a"] if invalid == "cycle" else [], outcome="PASS" if invalid == "cycle" else "FAIL")
                    f.control.plan({"complete": True, "issues": rows})
                if invalid == "missing":
                    f.control.plan({"complete": True, "issues": {}})
                if invalid == "restart-lease":
                    f.reopen()
                    f.arm()
                before = f.control._journal.tail
                with self.assertRaises(Blocked):
                    f.control.claim("mock-a", "review" if invalid == "stage" else "implementation", digest("wrong") if invalid == "fingerprint" else digest("a"), "mock-run")
                self.assertEqual(before, f.control._journal.tail)
                self.assertEqual(f.control._journal.body["operations"], {})
                self.assertEqual(f.control._journal.body["runs"], {})
            finally:
                f.close()

    def test_dependency_update_invalidates_claim_and_inflight_eligibility(self):
        for action in ("claim", "effect", "completion"):
            f = Fixture()
            try:
                f.arm()
                rows = {"mock-a": issue("review", ["mock-b"], fingerprint=digest("a")), "mock-b": issue(outcome="PASS")}
                f.control.plan({"complete": True, "issues": rows})
                fence = f.control.claim("mock-a", "review", digest("a"), "mock-run") if action != "claim" else None
                rows["mock-b"]["outcome"] = "FAIL"
                f.control.plan({"complete": True, "issues": rows})
                with self.assertRaises(Blocked):
                    if action == "claim":
                        f.control.claim("mock-a", "review", digest("a"), "mock-run")
                    elif action == "effect":
                        f.control.effect(fence)
                    else:
                        f.finish(fence)
                self.assertEqual(f.sink.initiations, ())
            finally:
                f.close()

    def test_caller_snapshot_mutation_and_incomplete_cycle_do_not_leave_eligible_work(self):
        f = Fixture()
        try:
            f.arm()
            rows = {"mock-a": issue(fingerprint=digest("a"))}
            f.control.plan({"complete": True, "issues": rows})
            rows["mock-a"]["outcome"] = "FAIL"
            self.assertEqual(f.control._journal.body["snapshot"]["issues"]["mock-a"]["outcome"], "PENDING")
            with self.assertRaises(Blocked):
                f.control.plan({"complete": False, "issues": rows})
            self.assertFalse(f.control.enabled)
            with self.assertRaises(Blocked):
                f.control.claim("mock-a", "implementation", digest("a"), "mock-run")
        finally:
            f.close()

    def test_independent_verifier_receipt_is_source_bound_read_only_and_probe_required(self):
        f = Fixture()
        try:
            f.arm()
            f.claim()
            receipt = f.control.halt(REQUEST, f.scope["caller"])
            self.assertEqual(receipt["outcome"], "LOCAL_STOPPED")
            self.assertEqual(receipt["verification"]["source"], f.scope["source"])
            self.assertTrue(receipt["verification"]["probe"]["denied"])
            persisted = f.control._journal.body["stops"][REQUEST]["receipt"]
            self.assertEqual(persisted["verification"], receipt["verification"])
            before = {p.name: p.read_bytes() for p in f.sandbox.root.iterdir() if p.name.endswith(("sqlite3", "-wal"))}
            verdict = f.control.inspect()
            with patch("local_coordinator.verifier.source_digest", return_value="0" * 64):
                with self.assertRaisesRegex(Blocked, "source-scope"):
                    verify_stop(f.sandbox, verdict["hash"], f.scope, verdict["epoch"], verdict["probe"])
            for wrong in ("source", "probe", "epoch", "hash"):
                probe, scope, epoch, tail = copy.deepcopy(verdict["probe"]), copy.deepcopy(f.scope), verdict["epoch"], verdict["hash"]
                if wrong == "source":
                    scope["source"] = "0" * 64
                elif wrong == "probe":
                    probe["denied"] = False
                elif wrong == "epoch":
                    epoch += 1
                else:
                    tail = "0" * 64
                with self.assertRaises(Blocked):
                    verify_stop(f.sandbox, tail, scope, epoch, probe)
            self.assertEqual(before, {p.name: p.read_bytes() for p in f.sandbox.root.iterdir() if p.name.endswith(("sqlite3", "-wal"))})
        finally:
            f.close()

    def test_command_contracts_and_idempotency_survive_reopen_without_original_rollback_writes(self):
        f = Fixture()
        try:
            selected = f.sandbox_new()
            snapshot_options = options(f, request_id=SNAPSHOT_REQUEST)
            snapshot = f.control.invoke("snapshot", snapshot_options, candidate=selected)
            self.assertEqual(snapshot, f.control.invoke("snapshot", snapshot_options, candidate=selected))
            f.arm()
            fence = f.claim()
            f.control.handle("mock-handle", START, START, START + DAY)
            f.finish(fence)
            halt_options = options(f, request_id=REQUEST, operator="roy", reason="manual")
            halt = f.control.invoke("halt", halt_options)
            self.assertEqual(halt["outcome"], "LOCAL_STOPPED")
            inspect_options = options(f, read_only=True, expect_disabled=True)
            self.assertTrue(f.control.invoke("inspect", inspect_options)["verified"])
            revoke_options = options(f, request_id=REVOKE_REQUEST, credential_ref="mock-handle", provider="jira-oauth")
            revoked = f.control.invoke("revoke-plan", revoke_options)
            self.assertEqual(revoked["provider_operations"], "BLOCKED_UNEXECUTED")
            self.assertEqual(revoked["start"], f.control._journal.body["control"]["start_utc"])
            self.assertEqual(set(revoked["operations"]), set(f.scope["resources"]))
            self.assertEqual(revoked, f.control.invoke("revoke-plan", revoke_options))
            f.reopen()
            self.assertEqual(halt, f.control.invoke("halt", halt_options))
            self.assertEqual(snapshot, f.control.invoke("snapshot", snapshot_options, candidate=selected))
            self.assertEqual(revoked, f.control.invoke("revoke-plan", revoke_options))
            candidate = Sandbox.request_candidate(f.sandbox, ROLLBACK_REQUEST)
            rollback_options = options(f, request_id=ROLLBACK_REQUEST, snapshot_id=snapshot["snapshot"], expected_epoch=f.control._journal.body["control"]["epoch"])
            original = {p.name: p.read_bytes() for p in f.sandbox.root.iterdir() if p.name.endswith(("sqlite3", "-wal"))}
            result = f.control.invoke("rollback", rollback_options, candidate=candidate, selected=selected, snapshot_receipt=snapshot)
            print("LOCAL_COORDINATOR_EVIDENCE " + json.dumps({"fixture_root": str(f.sandbox.root), "selected_root": str(selected.root), "candidate_root": str(candidate.root), "fixture": f.scope["fixture"], "issue": "mock-issue", "operation": fence[3], "generation": fence[1], "claim_epoch": fence[2], "stop_epoch": rollback_options["expected_epoch"], "source": f.scope["source"], "policy": f.scope["policy"], "config": f.scope["config"], "snapshot": snapshot["snapshot"], "restored_tail": result["tail"], "verification": halt["verification"]["verification_hash"], "external": "BLOCKED_UNEXECUTED"}, sort_keys=True))
            self.assertEqual(result, f.control.invoke("rollback", rollback_options, candidate=candidate, selected=selected, snapshot_receipt=snapshot))
            f.reopen()
            candidate = Sandbox.request_candidate(f.sandbox, ROLLBACK_REQUEST, existing=True)
            self.assertEqual(result, f.control.invoke("rollback", rollback_options, candidate=candidate, selected=selected, snapshot_receipt=snapshot))
            self.assertEqual(original, {p.name: p.read_bytes() for p in f.sandbox.root.iterdir() if p.name.endswith(("sqlite3", "-wal"))})
            for command, changed in (("snapshot", options(f, request_id=REQUEST)), ("revoke-plan", {**revoke_options, "provider": "token-store"}), ("rollback", {**rollback_options, "expected_epoch": 999})):
                with self.assertRaises(Blocked):
                    f.control.invoke(command, changed, candidate=candidate, selected=selected, snapshot_receipt=snapshot)
            self.assertEqual(f.control.invoke("halt", {**halt_options, "request_id": ROLLBACK_REQUEST})["outcome"], "BLOCKED")
        finally:
            f.close()

    def test_stop_crash_cuts_preserve_state_and_never_certify_incomplete_stop(self):
        cuts = [(event, point) for event in ("disable-linearization", "stop-evidence", "stop-verifier-receipt") for point in ("before-commit", "after-sqlite-commit", "before-fsync", "after-fsync", "after-commit")]
        for event, point in cuts:
            f = Fixture()
            try:
                f.arm()
                fence = f.claim()
                f.control.effect(fence)
                f.control._journal.fault = f"{event}:{point}"
                result = f.control.halt(REQUEST, f.scope["caller"])
                self.assertEqual(result["outcome"], "BLOCKED", (event, point))
                self.assertFalse(f.control.enabled)
                body, tail = read_only(f.control._journal.path)
                self.assertIn(fence[3], body["operations"])
                self.assertEqual(body["runs"]["mock-run"], 1)
                self.assertEqual(body["operations"][fence[3]]["attempts"], [digest([fence[3], 1])])
                f.control._journal.fault = None
                f.control._journal.close()
                f.control = MockControl.reopen(f.sandbox, f.scope, f.clock, f.sink, tail)
                f.journals.append(f.control._journal)
                self.assertFalse(f.control.enabled)
                with self.assertRaises(Blocked):
                    f.control.effect(fence)
                self.assertEqual(len(f.sink.initiations), 1)
            finally:
                f.close()
        for point in ("before-cancellation", "after-cancellation", "after-verifier"):
            f = Fixture()
            try:
                f.arm()
                fence = f.claim()
                f.control.stop_fault = point
                self.assertEqual(f.control.halt(REQUEST, f.scope["caller"])["outcome"], "BLOCKED")
                self.assertFalse(f.control.enabled)
                self.assertIn(fence[3], read_only(f.control._journal.path)[0]["operations"])
                f.reopen()
                self.assertFalse(f.control.enabled)
                with self.assertRaises(Blocked):
                    f.control.effect(fence)
            finally:
                f.close()

    def test_epoch_generation_overflow_and_incomplete_migration_fail_closed_preserving_bytes(self):
        for field in ("epoch", "generation"):
            f = Fixture()
            try:
                if field == "epoch":
                    f.arm()
                with f.control._journal.transaction("synthetic-overflow-fixture") as body:
                    body["control"][field] = 2 ** 63 - 1
                if field == "epoch":
                    self.assertEqual(f.control.halt(REQUEST, f.scope["caller"])["outcome"], "BLOCKED")
                else:
                    with self.assertRaisesRegex(Blocked, "overflow"):
                        f.arm()
                self.assertFalse(f.control.enabled)
            finally:
                f.close()
        for migration in ("CREATE TABLE incomplete_migration(id INTEGER)", "PRAGMA user_version=2", "UPDATE state SET body='{}'"):
            f = Fixture()
            try:
                f.control._journal.db.execute(migration)
                before = {p.name: p.read_bytes() for p in f.sandbox.root.iterdir() if p.name.endswith(("sqlite3", "-wal"))}
                with self.assertRaises(Blocked):
                    Journal(f.sandbox, expected=f.control._journal.tail)
                f.control._journal.close()
                self.assertEqual(before, {p.name: p.read_bytes() for p in f.sandbox.root.iterdir() if p.name.endswith(("sqlite3", "-wal"))})
            finally:
                f.close()

    def test_cold_process_restart_preserves_charges_closes_admission_and_rejects_cached_handles(self):
        f = Fixture()
        try:
            f.arm()
            fence = f.claim(records=7)
            f.control.handle("mock-handle", START, START, START + DAY)
            for stopped in (False, True):
                if stopped:
                    f.control.halt(REQUEST, f.scope["caller"])
                payload = {"root": str(f.sandbox.root), "identity": f.sandbox.identity, "scope": f.scope, "tail": f.control._journal.tail, "clock": {"utc": f.clock.utc, "mono": f.clock.mono, "boot": f.clock.boot, "suspend_supported": True}, "fence": fence}
                f.control._journal.close()
                script = '''
import json, sys
from local_coordinator.core import Blocked, MockClock
from local_coordinator.control import MockControl, RecordingSink
from local_coordinator.journal import Sandbox
p = json.load(sys.stdin)
c = MockControl.reopen(Sandbox.existing(p["root"], p["identity"]), p["scope"], MockClock(**p["clock"]), RecordingSink(), p["tail"])
assert not c.enabled
for action in (lambda: c.effect(tuple(p["fence"])), lambda: c.read_handle("mock-handle", tuple(p["fence"]))):
    try:
        action()
        raise AssertionError("admission was not denied")
    except Blocked:
        pass
assert c._journal.body["runs"]["mock-run"] == 7
assert c.sink.initiations == () and c.sink.reads == ()
c._journal.close()
print("COLD_RESTART_DISABLED")
'''
                result = subprocess.run([sys.executable, "-B", "-c", script], input=json.dumps(payload), text=True, capture_output=True, timeout=10, env={"PATH": os.defpath, "PYTHONPATH": str(Path(__file__).resolve().parents[2] / "tools/local-coordinator/src")})
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout.strip(), "COLD_RESTART_DISABLED")
                f.control = MockControl.reopen(f.sandbox, f.scope, f.clock, f.sink, payload["tail"])
                f.journals.append(f.control._journal)
        finally:
            f.close()

    def test_ambiguous_claim_or_changed_snapshot_metadata_quarantines_rollback(self):
        for defect in ("claim", "metadata"):
            f = Fixture()
            try:
                f.arm()
                fence = f.claim()
                if defect == "claim":
                    f.control.effect(fence)
                f.control.halt(REQUEST, f.scope["caller"])
                selected, candidate = f.sandbox_new(), f.sandbox_new()
                epoch = f.control._journal.body["control"]["epoch"]
                receipt = f.control.snapshot(selected, epoch, f.scope["caller"])
                if defect == "metadata":
                    receipt = {**receipt, "code": "0" * 64}
                with self.assertRaisesRegex(Blocked, "quarantined"):
                    f.control.rollback(selected, candidate, epoch, receipt, f.scope["caller"])
                self.assertTrue((f.sandbox.root / "quarantined").is_file())
                self.assertTrue((candidate.root / "quarantined").is_file())
                self.assertFalse(f.control.enabled)
            finally:
                f.close()

    def test_revocation_ambiguity_branches_block_without_retry_and_sink_records_are_immutable(self):
        observed = {"source": "synthetic", "provider": "github-installation", "prior_protected_read": True, "read_status": 401, "write_status": 401, "final": True}
        for provider in ("github-installation", "jira-oauth"):
            self.assertEqual(revocation_outcome({**observed, "provider": provider})["outcome"], "SIMULATED_AUTH_DENIED")
        for change in ({"read_status": 403}, {"read_status": 404}, {"write_status": 403}, {"write_status": 404}, {"read_status": 200}, {"write_status": 200}, {"read_status": None}, {"final": False}, {"source": "shared-account-signature"}, {"prior_protected_read": False}, {"provider": "unknown"}):
            result = revocation_outcome({**observed, **change})
            self.assertEqual(result["outcome"], "BLOCKED")
            self.assertFalse(result["retry"])
            self.assertEqual(result["external"], "BLOCKED_UNEXECUTED")
        f = Fixture()
        try:
            f.arm()
            fence = f.claim()
            f.control.handle("mock-handle", START, START, START + DAY)
            f.control.read_handle("mock-handle", fence)
            f.control.effect(fence)
            before = f.sink.initiations
            with self.assertRaises(AttributeError):
                f.sink.initiations.append(fence)
            for field, value in (("initiations", ()), ("reads", ()), ("restore_calls", 1), ("dispatch_calls", 1)):
                with self.assertRaises(AttributeError):
                    setattr(f.sink, field, value)
            self.assertEqual(before, f.sink.initiations)
            f.control.halt(REQUEST, f.scope["caller"])
            handle = f.control._journal.body["handles"]["mock-handle"]
            self.assertTrue(handle["revoked"])
            self.assertEqual(handle["revoked_epoch"], f.control._journal.body["control"]["epoch"])
            for provider in ("github-installation", "jira-oauth", "token-store"):
                req = {"github-installation": SNAPSHOT_REQUEST, "jira-oauth": ROLLBACK_REQUEST, "token-store": REVOKE_REQUEST}[provider]
                receipt = f.control.invoke("revoke-plan", options(f, request_id=req, credential_ref="mock-handle", provider=provider))
                self.assertEqual(receipt["provider_operations"], "BLOCKED_UNEXECUTED")
            with self.assertRaises(Blocked):
                f.control.read_handle("mock-handle", fence)
            self.assertEqual(f.sink.reads, ("mock-handle",))
        finally:
            f.close()
