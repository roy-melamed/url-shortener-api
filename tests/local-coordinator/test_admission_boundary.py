"""F1: time may advance during validation, never between final check and sink."""
import threading
import unittest
from unittest.mock import patch
from local_coordinator.core import Blocked, DAY, SECOND
from local_coordinator.control import RecordingSink
from fixtures import Fixture, START


class AdmissionBoundaryTests(unittest.TestCase):
    def _fixture(self, branch):
        f = Fixture(start=START - 14 * DAY + SECOND) if branch == "fixture" else Fixture()
        f.arm()
        provider = START + SECOND if branch == "provider" else START + DAY
        f.control.handle("mock-handle", START, START, provider)
        deadline = f.control._journal.body["handles"]["mock-handle"]["deadline"]
        # Begin validation one second before each selected deadline, not thirty
        # minutes into an already timed-out job in the one-hour branch.
        if deadline - f.clock.utc > SECOND:
            f.clock.advance(deadline - f.clock.utc - SECOND)
        return f, deadline, f.claim()

    def _delayed_validation_matrix(self, concurrent):
        for branch in ("fixture", "provider", "one-hour"):
            for action in ("effect", "read"):
                for offset in (-1, 0, 1):
                    with self.subTest(branch=branch, action=action, offset=offset, concurrent=concurrent):
                        f, deadline, fence = self._fixture(branch)
                        worker = None
                        try:
                            original = f.control._fence
                            attempts = list(f.control._journal.body["operations"][fence[3]]["attempts"])
                            fixture_deadline = f.control._journal.body["control"]["deadline"]
                            release, advanced = threading.Event(), threading.Event()
                            errors = []

                            def advance():
                                try:
                                    if not release.wait(2):
                                        raise AssertionError("validation barrier not reached")
                                    f.clock.advance(deadline + offset - f.clock.utc)
                                except BaseException as error:
                                    errors.append(error)
                                finally:
                                    advanced.set()

                            if concurrent:
                                worker = threading.Thread(target=advance)
                                worker.start()

                            def delayed(body, value):
                                row = original(body, value)
                                if concurrent:
                                    release.set()
                                    self.assertTrue(advanced.wait(2))
                                    self.assertEqual(errors, [])
                                else:
                                    f.clock.advance(deadline + offset - f.clock.utc)
                                return row

                            with patch.object(f.control, "_fence", side_effect=delayed), patch.object(f.control, "watchdog", side_effect=AssertionError("must not rely on later watchdog")):
                                if offset < 0:
                                    result = f.control.effect(fence) if action == "effect" else f.control.read_handle("mock-handle", fence)
                                    self.assertTrue(f.control.enabled)
                                    self.assertEqual(len(f.sink.initiations), int(action == "effect"))
                                    self.assertEqual(len(f.sink.reads), int(action == "read"))
                                    self.assertEqual(result.get("outcome", "MOCK_READ"), "MOCK_INITIATED" if action == "effect" else "MOCK_READ")
                                else:
                                    with self.assertRaisesRegex(Blocked, "expired-or-clock"):
                                        if action == "effect":
                                            f.control.effect(fence)
                                        else:
                                            f.control.read_handle("mock-handle", fence)
                                    self.assertFalse(f.control.enabled)
                                    self.assertEqual(f.sink.initiations, ())
                                    self.assertEqual(f.sink.reads, ())
                                    body = f.control._journal.body
                                    self.assertEqual(body["control"]["state"], "EXPIRED")
                                    self.assertEqual(body["control"]["epoch"], fence[2] + 1)
                                    self.assertEqual(body["control"]["deadline"], fixture_deadline)
                                    self.assertEqual(body["handles"]["mock-handle"]["deadline"], deadline)
                                    self.assertTrue(body["handles"]["mock-handle"]["revoked"])
                                    self.assertEqual(body["operations"][fence[3]]["attempts"], attempts)
                                    self.assertEqual(body["runs"]["mock-run"], 1)
                                    self.assertEqual(sum(body["minutes"].values()), 30)
                                    self.assertTrue(f.control.inspect()["verified"])
                            if offset >= 0:
                                # Expiry/stop is already durable BEFORE any later
                                # watchdog, restart, retry or stale worker call.
                                tail = f.control._journal.tail
                                f.reopen()
                                self.assertEqual(f.control._journal.tail, tail)
                                self.assertEqual(f.control._journal.body["control"]["state"], "EXPIRED")
                                for denied in (lambda: f.control.effect(fence), lambda: f.control.read_handle("mock-handle", fence), lambda: f.control.retry(fence, "transient", True)):
                                    with self.assertRaises(Blocked):
                                        denied()
                                self.assertEqual(f.control._journal.tail, tail)
                        finally:
                            release.set()
                            if worker is not None:
                                worker.join(2)
                                self.assertFalse(worker.is_alive())
                            f.close()

    def test_delayed_validation_deadline_matrix(self):
        self._delayed_validation_matrix(concurrent=False)

    def test_concurrent_clock_advance_during_validation_deadline_matrix(self):
        self._delayed_validation_matrix(concurrent=True)

    def _clock_serialization_matrix(self, direct):
        for action in ("effect", "read"):
            with self.subTest(action=action):
                f, deadline, fence = self._fixture("provider")
                entered, attempted, finished = threading.Event(), threading.Event(), threading.Event()
                observations, errors = [], []
                method = "_initiate" if action == "effect" else "_read"
                original = getattr(RecordingSink, method)

                def advance():
                    try:
                        if not entered.wait(2):
                            raise AssertionError("sink boundary not reached")
                        acquired = f.clock.admission_gate.acquire(blocking=False)
                        if acquired:
                            f.clock.admission_gate.release()
                        observations.append(acquired)
                        attempted.set()
                        amount = deadline - f.clock.utc
                        if direct:
                            f.clock.utc = deadline
                            f.clock.mono += amount
                        else:
                            f.clock.advance(amount)
                        finished.set()
                    except BaseException as error:
                        errors.append(error)
                        attempted.set()

                def record(sink, value):
                    entered.set()
                    self.assertTrue(attempted.wait(2))
                    self.assertFalse(finished.is_set())
                    self.assertLess(f.clock.utc, deadline)
                    original(sink, value)

                worker = threading.Thread(target=advance)
                worker.start()
                try:
                    with patch.object(RecordingSink, method, new=record):
                        if action == "effect":
                            f.control.effect(fence)
                        else:
                            f.control.read_handle("mock-handle", fence)
                    worker.join(2)
                    self.assertFalse(worker.is_alive())
                    self.assertEqual(errors, [])
                    self.assertEqual(observations, [False])
                    self.assertEqual(f.clock.utc, deadline)
                    self.assertEqual(len(f.sink.initiations), int(action == "effect"))
                    self.assertEqual(len(f.sink.reads), int(action == "read"))
                    # This transmission preceded expiry. A new one at equality
                    # is denied and expires without requiring a watchdog.
                    with self.assertRaisesRegex(Blocked, "expired-or-clock"):
                        f.control.read_handle("mock-handle", fence)
                    self.assertEqual(f.control._journal.body["control"]["state"], "EXPIRED")
                    self.assertEqual(len(f.sink.initiations), int(action == "effect"))
                    self.assertEqual(len(f.sink.reads), int(action == "read"))
                finally:
                    entered.set()
                    worker.join(2)
                    f.close()

    def test_clock_cannot_advance_between_final_check_and_effect_or_read_record(self):
        self._clock_serialization_matrix(direct=False)

    def test_direct_clock_assignments_cannot_cross_final_effect_or_read_boundary(self):
        self._clock_serialization_matrix(direct=True)

    def test_job_timeout_is_resampled_after_validation_before_effect_or_read(self):
        for action in ("effect", "read"):
            f = Fixture()
            try:
                f.arm()
                f.control.handle("mock-handle", START, START, START + DAY)
                fence = f.claim()
                original = f.control._fence

                def delayed(body, value):
                    row = original(body, value)
                    f.clock.advance(1800 * SECOND)
                    return row

                with patch.object(f.control, "_fence", side_effect=delayed):
                    with self.assertRaisesRegex(Blocked, "job-timeout"):
                        if action == "effect":
                            f.control.effect(fence)
                        else:
                            f.control.read_handle("mock-handle", fence)
                self.assertFalse(f.control.enabled)
                self.assertEqual(f.control._journal.body["control"]["state"], "STOPPED")
                self.assertEqual(f.sink.initiations, ())
                self.assertEqual(f.sink.reads, ())
            finally:
                f.close()
