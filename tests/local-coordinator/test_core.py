import copy
import unittest
from local_coordinator.core import Blocked, DAY, SECOND, GIB, MockClock, clock_verdict, completion, credential_deadline, digest, ns, reconcile, reservation_fits, stamp, valid_format, validate_document
from fixtures import START, evidence, issue


class CoreTests(unittest.TestCase):
    def test_document_identity_independent_dimensions_and_format(self):
        text = "# Local Coordinator Stop, Expiry, and Recovery Requirements v9\n\n**Version:** 2026-11-22-local-stop-expiry.9\n"
        self.assertTrue(validate_document("fixture.v9.md", 9, text))
        for path, revision, content in [("fixture.v8.md", 9, text), ("fixture.v9.md", 8, text), ("fixture.v9.md", 9, text.replace("Requirements v9", "Requirements v8")), ("fixture.v9.md", 9, text.replace("expiry.9", "expiry.8")), ("fixture.v9.md", 9, text.replace("expiry.9", "expiry.9garbage")), ("fixture.v9.md", 9, text.replace("expiry.9", "expiry.9 trailing")), ("fixture.v9.md", 9, "")]:
            self.assertFalse(validate_document(path, revision, content))
        self.assertTrue(validate_document("fixture.v10.md", 10, text.replace("v9", "v10").replace("expiry.9", "expiry.10")))
        self.assertTrue(valid_format(text))
        for content in (text + "\n", text.replace("\n", "\r\n"), text + "```\n", text[:-1], text.replace("expiry.9", "expiry.9 ")):
            self.assertFalse(valid_format(content))

    def test_exact_nanoseconds_and_deadline_formula_each_earliest(self):
        self.assertEqual(ns(stamp(START + 1)), START + 1)
        deadline = START + 14 * DAY
        self.assertEqual(credential_deadline(deadline, deadline - SECOND, deadline - SECOND, deadline + DAY), deadline)
        self.assertEqual(credential_deadline(deadline, START, START + SECOND, deadline), START + 3600 * SECOND)
        self.assertEqual(credential_deadline(deadline, START, START, START + SECOND), START + SECOND)
        for value in (None, "unknown", -1, True):
            with self.assertRaises(Blocked):
                credential_deadline(deadline, value, START, deadline)

    def test_clock_exact_disagreement_boundary_boot_and_rollback(self):
        c = {"boot": "mock-boot", "high_water": START, "last_mono": 0, "anchor_utc": START, "anchor_mono": 0}
        clock = MockClock(START, suspend_supported=True)
        for delta, allowed in ((SECOND - 1, True), (SECOND, True), (SECOND + 1, False)):
            clock.utc, clock.mono = START + delta, 0
            if allowed:
                self.assertEqual(clock_verdict(c, clock, START + DAY), "CURRENT")
            else:
                with self.assertRaisesRegex(Blocked, "clock-disagreement"):
                    clock_verdict(c, clock, START + DAY)
            clock.utc, clock.mono = START, delta
            if allowed:
                self.assertEqual(clock_verdict(c, clock, START + DAY), "CURRENT")
            else:
                with self.assertRaisesRegex(Blocked, "clock-disagreement"):
                    clock_verdict(c, clock, START + DAY)
        for clock in (MockClock(START - 1, suspend_supported=True), MockClock(START, -1, suspend_supported=True), MockClock(START, boot="mock-other", suspend_supported=True), MockClock(START)):
            with self.assertRaises(Blocked):
                clock_verdict(c, clock, START + DAY)
        for delta in (-1, 0, 1):
            clock = MockClock(START + DAY + delta, DAY + delta, suspend_supported=True)
            self.assertEqual(clock_verdict(c, clock, START + DAY), "CURRENT" if delta < 0 else "EXPIRED")

    def test_union_stuck_unchanged_missing_and_dependency_isolation(self):
        rows = {"mock-a": issue(), "mock-b": issue("review"), "mock-c": issue(dependencies=["mock-blocked"]), "mock-blocked": issue(outcome="BLOCKED")}
        persisted = {"mock-b": {"state": "CLAIMED"}, "mock-missing": {"state": "UNKNOWN"}}
        before = copy.deepcopy((rows, persisted))
        plan = reconcile({"complete": True, "issues": rows}, persisted)
        self.assertEqual(plan["mock-a"]["outcome"], "DRY_RUN")
        self.assertEqual(plan["mock-b"]["reason"], "uncertain-operation")
        self.assertEqual(plan["mock-missing"]["reason"], "missing-snapshot")
        self.assertEqual(plan["mock-c"]["reason"], "dependency")
        self.assertEqual(plan, reconcile({"complete": True, "issues": rows}, persisted))
        self.assertEqual((rows, persisted), before)
        with self.assertRaises(Blocked):
            reconcile({"complete": False, "issues": rows}, persisted)
        for stage in ("approved", "human", "deployment"):
            self.assertEqual(reconcile({"complete": True, "issues": {"mock-a": issue(stage)}}, {})["mock-a"]["reason"], "protected-gate")

    def test_exact_reservation_caps_and_unknown_or_negative_inputs(self):
        boundary = [100, 25, 200, GIB, 1]
        self.assertTrue(reservation_fits(*boundary))
        for index in range(5):
            for bad in (boundary[index] + 1, -1, None, True):
                values = list(boundary)
                values[index] = bad
                self.assertFalse(reservation_fits(*values))

    def test_completion_positive_comment_is_simulation_not_identity_or_approval(self):
        expected, record = evidence()
        self.assertEqual(completion("review", expected, record), {"outcome": "SIMULATED_PASS", "formal_approval": False, "authenticated": False})
        for stage, role in (("merge", "michael"), ("qa", "pam")):
            record["final"]["role"] = role
            self.assertEqual(completion(stage, expected, record)["outcome"], "SIMULATED_PASS")

    def test_all_negative_evidence_predicates(self):
        expected, original = evidence()
        patches = [{"final": {}}, {"source": "shared-account-signature"}, {"verdict": "FAIL"}, {"head": "0" * 40}, {"base": "0" * 40}, {"test_merge": "0" * 40}, {"checks": {}}]
        for key, value in (("kind", "idle"), ("kind", "unknown"), ("kind", "timeout"), ("kind", "prompt-echo"), ("session", "mock-other"), ("pane", "mock-other"), ("operation", digest("wrong")), ("token", digest("wrong")), ("artifact", "mock-other"), ("role", "pam")):
            patches.append({"final": {**original["final"], key: value}})
        for patch in patches:
            self.assertEqual(completion("review", expected, {**original, **patch})["outcome"], "FAIL" if patch.get("verdict") == "FAIL" else "BLOCKED")
        for conclusion in (None, "pending", "skipped", "neutral", "cancelled", "stale", "failure"):
            record = copy.deepcopy(original)
            record["checks"]["tests"]["conclusion"] = conclusion
            self.assertEqual(completion("review", expected, record)["outcome"], "FAIL" if conclusion == "failure" else "BLOCKED")
        original["final"]["role"] = "pam"
        for patch in ({"tested": "0" * 40}, {"main": "0" * 40}, {"qa_role": "ryan"}):
            self.assertEqual(completion("qa", expected, {**original, **patch})["outcome"], "BLOCKED")
