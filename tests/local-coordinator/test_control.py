import json
import threading
import unittest
from local_coordinator.core import Blocked, DAY, SECOND, GIB, digest
from local_coordinator.control import MockControl
from local_coordinator.journal import Crash, Journal, read_only
from fixtures import Fixture, REQUEST, START, issue


class ControlTests(unittest.TestCase):
    def setUp(self):
        self.f = Fixture()

    def tearDown(self):
        self.f.close()

    def test_disabled_start_no_writes_no_dispatch_and_explicit_admission(self):
        f = self.f
        before = f.control._journal.tail
        self.assertFalse(f.control.enabled)
        result = f.control.plan({"complete": True, "issues": {"mock-a": issue()}})
        self.assertEqual(result["mode"], "DISABLED_DRY_RUN")
        self.assertEqual(before, f.control._journal.tail)
        with self.assertRaises(Blocked):
            f.claim()
        self.assertEqual(before, f.control._journal.tail)
        with self.assertRaises(Blocked):
            f.control.arm_mock("mock-unknown")
        f.arm()
        fence = f.claim()
        f.control.effect(fence)
        f.finish(fence)
        self.assertEqual(len(f.sink.initiations), 1)
        self.assertEqual((f.sink.restore_calls, f.sink.dispatch_calls), (0, 0))

    def test_reopen_disabled_old_leases_invalid_and_budget_never_reset(self):
        f = self.f
        f.arm()
        fence = f.claim(records=10)
        old = json.loads(json.dumps(f.control._journal.body))
        f.reopen()
        self.assertFalse(f.control.enabled)
        with self.assertRaises(Blocked):
            f.control.effect(fence)
        self.assertEqual(f.control._journal.body, old)
        f.arm()
        self.assertEqual(f.control._journal.body["runs"], old["runs"])
        self.assertGreater(f.control._journal.body["control"]["epoch"], old["control"]["epoch"])
        with self.assertRaises(Blocked):
            f.control.effect(fence)

    def test_stop_idempotency_no_post_disable_writes_reads_or_effects(self):
        f = self.f
        f.arm()
        fence = f.claim()
        f.control.handle("mock-handle", START, START, START + DAY)
        f.control.read_handle("mock-handle", fence)
        f.control.effect(fence)
        receipt = f.control.halt(REQUEST, f.scope["caller"])
        self.assertEqual(receipt["outcome"], "LOCAL_STOPPED")
        self.assertTrue(f.control.inspect()["verified"])
        tail, counts = f.control._journal.tail, (len(f.sink.initiations), len(f.sink.reads))
        self.assertEqual(f.control.halt(REQUEST, f.scope["caller"]), receipt)
        self.assertEqual(tail, f.control._journal.tail)
        self.assertEqual(f.control.halt(REQUEST, f.scope["caller"], "recovery")["outcome"], "BLOCKED")
        for action in (lambda: f.control.effect(fence), lambda: f.control.finish(fence, "mock-evidence"), lambda: f.control.read_handle("mock-handle", fence), lambda: f.control.retry(fence, "transient", True), lambda: f.claim()):
            with self.assertRaises(Blocked):
                action()
            self.assertEqual(tail, f.control._journal.tail)
        self.assertEqual(counts, (len(f.sink.initiations), len(f.sink.reads)))
        self.assertEqual(f.control._journal.body["operations"][fence[3]]["state"], "UNKNOWN")
        plan = f.control.revoke_plan("00000000-0000-4000-8000-000000000002", f.scope["caller"], "mock-handle")
        self.assertEqual(plan["references"], ["mock-handle"])
        self.assertEqual(plan["provider_operations"], "BLOCKED_UNEXECUTED")
        f.reopen()
        self.assertFalse(f.control.enabled)
        with self.assertRaises(Blocked):
            f.arm()

    def test_stop_deadline_before_at_after_five_seconds_and_unconfirmed_worker(self):
        for drain, confirmed, success in ((5 * SECOND - 1, True, True), (5 * SECOND, True, True), (5 * SECOND + 1, True, False), (0, False, False), (0, "unknown", False), (0, 1, False)):
            f = Fixture()
            try:
                f.arm()
                f.sink.drain_ns, f.sink.confirmed = drain, confirmed
                receipt = f.control.halt(REQUEST, f.scope["caller"])
                self.assertFalse(f.control.enabled)
                self.assertEqual(receipt["outcome"] == "LOCAL_STOPPED", success)
                if not success:
                    self.assertEqual(receipt["outcome"], "BLOCKED")
            finally:
                f.close()

    def test_stop_ignores_quota_and_blocks_honestly_on_failed_storage(self):
        for fault in (None, "storage", "fsync"):
            f = Fixture()
            try:
                f.arm()
                f.claim(records=100, storage=GIB)
                f.control._journal.fault = fault
                receipt = f.control.halt(REQUEST, f.scope["caller"])
                self.assertFalse(f.control.enabled)
                self.assertEqual(receipt["outcome"], "LOCAL_STOPPED" if fault is None else "BLOCKED")
                self.assertEqual(f.control._journal.body["runs"]["mock-run"], 100)
                self.assertEqual(f.control._journal.body["storage"], GIB)
            finally:
                f.close()

    def test_two_client_admission_stop_race_and_stale_worker(self):
        f = self.f
        f.arm()
        barrier = threading.Barrier(3)
        results = []
        f.control.plan({"complete": True, "issues": {"mock-" + name: issue(fingerprint=digest(name)) for name in ("a", "b")}})
        def worker(name):
            barrier.wait()
            try:
                fence = f.control.claim("mock-" + name, "implementation", digest(name), "mock-run")
                f.control.effect(fence)
                results.append(fence)
            except Blocked:
                results.append(None)
        threads = [threading.Thread(target=worker, args=(name,)) for name in ("a", "b")]
        for thread in threads:
            thread.start()
        barrier.wait()
        receipt = f.control.halt(REQUEST, f.scope["caller"])
        for thread in threads:
            thread.join(2)
            self.assertFalse(thread.is_alive())
        self.assertEqual(receipt["outcome"], "LOCAL_STOPPED")
        self.assertLessEqual(len(f.sink.initiations), 1)
        count = len(f.sink.initiations)
        for fence in [value for value in results if value]:
            with self.assertRaises(Blocked):
                f.control.finish(fence, "mock-evidence")
        self.assertEqual(count, len(f.sink.initiations))

    def test_fixture_and_each_future_credential_expiry_branch_at_equality(self):
        for branch in ("fixture", "issuance", "provider"):
            f = Fixture(start=START - 14 * DAY + SECOND, now=START) if branch == "fixture" else Fixture()
            try:
                f.arm()
                deadline = f.control._journal.body["control"]["deadline"]
                if branch == "issuance":
                    f.control.handle("mock-handle", START, START, START + DAY)
                    deadline = START + 3600 * SECOND
                elif branch == "provider":
                    f.control.handle("mock-handle", START, START, START + SECOND)
                    deadline = START + SECOND
                delta = deadline - f.clock.utc
                f.clock.advance(delta - 1)
                f.control.watchdog()
                self.assertTrue(f.control.enabled)
                fence = f.claim()
                f.clock.advance(1)
                with self.assertRaisesRegex(Blocked, "expired-or-clock"):
                    f.control.effect(fence)
                self.assertFalse(f.control.enabled)
                self.assertEqual(f.control._journal.body["control"]["state"], "EXPIRED")
                receipt = f.control._journal.body["stops"]["00000000-0000-4000-8000-000000000000"]["receipt"]
                self.assertEqual(receipt["scope_plan"]["resources"], f.scope["resources"])
                self.assertEqual(receipt["scope_plan"]["operator"], "roy")
                self.assertTrue(receipt["verification"]["verified"])
                self.assertEqual(f.sink.initiations, ())
                f.reopen()
                with self.assertRaises(Blocked):
                    f.arm()
                self.assertEqual(f.control._journal.body["control"]["deadline"], deadline if branch == "fixture" else START + 14 * DAY)
            finally:
                f.close()

    def test_retry_three_attempts_and_observation_never_fourth(self):
        f = self.f
        f.arm()
        fence = f.claim()
        for delay, count in ((5, 2), (30, 3)):
            self.assertEqual(f.control.retry(fence, "transient", True)["outcome"], "WAIT")
            f.clock.advance(delay * SECOND - 1)
            self.assertEqual(f.control.retry(fence, "transient", True)["outcome"], "WAIT")
            f.clock.advance(1)
            self.assertEqual(f.control.retry(fence, "transient", True)["attempt"], count)
        self.assertEqual(f.control._journal.body["operations"][fence[3]]["observation"], f.clock.mono + 120 * SECOND)
        f.clock.advance(120 * SECOND)
        with self.assertRaisesRegex(Blocked, "retry-limit"):
            f.control.retry(fence, "transient", True)
        self.assertEqual(len(f.control._journal.body["operations"][fence[3]]["attempts"]), 3)

    def test_nontransient_retry_denied_without_new_attempt(self):
        for classification, proven in (("ambiguous", True), ("provider", True), ("permission", True), ("security", True), ("human", True), ("qa-fail", True), ("revocation", True), ("transient", False)):
            f = Fixture()
            try:
                f.arm()
                fence = f.claim()
                with self.assertRaisesRegex(Blocked, "retry-prohibited"):
                    f.control.retry(fence, classification, proven)
                self.assertEqual(len(f.control._journal.body["operations"][fence[3]]["attempts"]), 1)
            finally:
                f.close()

    def test_atomic_caps_replay_and_unknown_reservation_stays_charged(self):
        f = self.f
        f.arm()
        fence = f.claim(records=100, storage=GIB)
        before = json.loads(json.dumps(f.control._journal.body))
        self.assertEqual(f.claim(records=100, storage=GIB), fence)
        self.assertEqual(before, f.control._journal.body)
        f.finish(fence)
        f.prepare("mock-other", "review", digest("other"))
        with self.assertRaises(Blocked):
            f.control.claim("mock-other", "review", digest("other"), "mock-run", 1, 1)
        self.assertEqual(f.control._journal.body["runs"]["mock-run"], 100)
        self.assertEqual(f.control._journal.body["storage"], GIB)

    def test_union_journal_reopen_idempotency_and_rollback_wal(self):
        f = self.f
        f.arm()
        snapshot = {"complete": True, "issues": {"mock-a": issue(), "mock-b": issue("review")}}
        f.control.plan(snapshot)
        tail = f.control._journal.tail
        f.control.plan(snapshot)
        self.assertEqual(tail, f.control._journal.tail)
        fence = f.control.claim("mock-a", "implementation", snapshot["issues"]["mock-a"]["fingerprint"], "mock-run")
        self.assertEqual(f.control.plan(snapshot)["plans"]["mock-a"]["reason"], "uncertain-operation")
        f.control.halt(REQUEST, f.scope["caller"])
        selected, candidate = f.sandbox_new(), f.sandbox_new()
        epoch = f.control._journal.body["control"]["epoch"]
        receipt = f.control.snapshot(selected, epoch, f.scope["caller"])
        self.assertTrue(receipt["snapshot"])
        original_snapshot = (selected.root / "journal.sqlite3").read_bytes()
        prior = json.loads(json.dumps(f.control._journal.body))
        result = f.control.rollback(selected, candidate, epoch, receipt, f.scope["caller"])
        self.assertFalse(result["enabled"])
        restored, _ = read_only(candidate.root / "journal.sqlite3")
        self.assertEqual(restored["control"], f.control._journal.body["control"])
        self.assertTrue(f.control._journal.body["stops"].keys() <= restored["stops"].keys())
        self.assertEqual(original_snapshot, (selected.root / "journal.sqlite3").read_bytes())
        for key in ("control", "operations", "runs", "minutes", "reservations", "issues", "handles", "storage"):
            self.assertEqual(prior[key], restored[key])
        self.assertEqual(restored["operations"][fence[3]]["attempts"], f.control._journal.body["operations"][fence[3]]["attempts"])

    def test_current_head_gate_is_required_and_changed_snapshot_cannot_complete(self):
        for change in ("pending", "changed-snapshot", "missing-snapshot", "wrong-token", "wrong-session"):
            f = Fixture()
            try:
                f.arm()
                fence = f.claim()
                expected, record = f.completion(fence)
                if change == "pending":
                    record["checks"]["tests"]["status"] = "pending"
                elif change == "wrong-token":
                    expected["token"] = "0" * 64
                elif change == "wrong-session":
                    expected["session"] = "mock-wrong"
                else:
                    rows = {} if change == "missing-snapshot" else {"mock-issue":issue("review", fingerprint=digest("changed"))}
                    f.control.plan({"complete":True,"issues":rows})
                with self.assertRaises(Blocked):
                    f.control.finish(fence, "mock-evidence", expected, record)
                self.assertNotEqual(f.control._journal.body["operations"][fence[3]]["state"], "COMPLETED")
            finally:
                f.close()

    def test_completion_idempotency_and_fail_evidence_preserved(self):
        f = self.f
        f.arm()
        fence = f.claim()
        self.assertEqual(f.finish(fence)["outcome"], "SIMULATED_COMPLETION")
        tail = f.control._journal.tail
        self.assertEqual(f.finish(fence)["outcome"], "EXISTING_SIMULATED_COMPLETION")
        self.assertEqual(tail, f.control._journal.tail)
        f.prepare("mock-other", "qa", digest("qa"))
        other = f.control.claim("mock-other", "qa", digest("qa"), "mock-run")
        expected, record = f.completion(other)
        record["final"]["role"] = "pam"
        record["verdict"] = "FAIL"
        self.assertEqual(f.control.finish(other, "mock-failure", expected, record)["outcome"], "SIMULATED_FAIL")
        self.assertEqual(f.control._journal.body["operations"][other[3]]["state"], "FAILED")
        with self.assertRaises(Blocked):
            f.control.retry(other, "qa-fail", False)

    def test_superseded_broker_cannot_claim_new_work_even_sharing_a_journal(self):
        f = self.f
        old = f.arm()
        replacement = MockControl(old._journal, f.scope, f.clock, f.sink)
        self.assertFalse(replacement.enabled)
        replacement.arm_mock(f.scope["caller"])
        with self.assertRaisesRegex(Blocked, "lease-invalid"):
            old.claim("mock-a", "review", digest("a"), "mock-run")
        self.assertFalse(old.enabled)
        self.assertTrue(replacement.enabled)
        self.assertEqual(replacement.halt(REQUEST, f.scope["caller"])["outcome"], "LOCAL_STOPPED")
