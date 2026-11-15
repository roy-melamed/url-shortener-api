import json
import unittest
from datetime import timedelta
from email.utils import format_datetime

from evidence_watcher.model import OfflineError, stamp
from evidence_watcher.simulation import FixtureSource, FixtureTransport, OfflineScanner, VirtualClock, retry_seconds
from evidence_watcher.store import DisposableState
from fixtures import CONFIG, CREATED, FENCE, NOW, fixture, history, metadata, row, scanner


class ScannerTests(unittest.TestCase):
    def test_many_server_clamped_pages_and_complete_reopen_without_done_filter(self):
        histories = [history("old", "2026-01-01T00:04:00Z"),
                     history("review", "2026-01-01T00:05:00Z", "990011", "990010"),
                     history(), history("reopen", "2026-01-01T00:07:00Z", "990011", "990012")]
        rows = [row(metadata(str(990100 + n), status="990012"), histories) for n in range(4)]
        with DisposableState() as state:
            store = state.create(CONFIG, FENCE, CREATED)
            worker, _, transport, _ = scanner(store, fixture(rows, page_size=1))
            worker.poll()
            self.assertEqual(store.counts()["notification_outbox"], 4)
            self.assertEqual(len(store.known_issues()), 4)
            self.assertGreater(sum(op == "history" for op, _ in transport.calls), 4)
            self.assertTrue(all(row[0] == 1 for row in store._db.execute("SELECT superseded FROM processed_events WHERE classification='eligible'")))

    def test_more_than_one_hundred_retained_status_items_are_all_read(self):
        from evidence_watcher.model import utc
        start = utc("2026-01-01T00:06:00Z")
        histories = [history("history-" + str(n), stamp(start + timedelta(seconds=n)),
                     "990010" if n % 2 == 0 else "990011", "990011" if n % 2 == 0 else "990010")
                     for n in range(121)]
        with DisposableState() as state:
            store = state.create(CONFIG, FENCE, CREATED)
            worker, _, transport, _ = scanner(store, fixture([row(histories=histories)], page_size=17))
            worker.poll()
            self.assertEqual(sum(op == "history" for op, _ in transport.calls), 8)
            self.assertEqual(store.counts()["processed_events"], 121)
            self.assertEqual(store.counts()["notification_outbox"], 61)
            self.assertEqual(store.counts()["simulated_work_identities"], 1)

    def test_search_and_history_failure_never_complete_a_partial_window(self):
        invalid_searches = [
            {"values": [], "isLast": False, "nextPageToken": "1"},
            {"values": [], "isLast": True, "nextPageToken": "1"},
            {"values": [], "isLast": "true", "nextPageToken": None},
            {"values": [], "isLast": True},
        ]
        for page in invalid_searches:
            with self.subTest(page=page), DisposableState() as state:
                store = state.create(CONFIG, FENCE, CREATED)
                worker = scanner(store, fixture(overrides={"search": [page]}))[0]
                with self.assertRaises(OfflineError):
                    worker.poll()
                self.assertIsNone(store.state()["completed_upper"])
                self.assertIsNone(store.state()["full_upper"])
                self.assertEqual(store.state()["revision"], 0)
                self.assertEqual(store.counts()["notification_outbox"], 0)

    def test_repeated_search_token_or_nonprogressing_history_is_coverage_fault(self):
        first = {"values": [metadata()], "isLast": False, "nextPageToken": "same"}
        second = {"values": [metadata("990101")], "isLast": False, "nextPageToken": "same"}
        history_page = {"values": [history()], "startAt": 0, "total": 2, "isLast": False}
        cases = [{"search": [first, second]},
                 {"history:990100": [history_page, {**history_page, "startAt": 1, "isLast": True}]},
                 {"history:990100": [{"values": [], "startAt": 0, "total": 2, "isLast": False}]},
                 {"history:990100": [{"values": [history()], "startAt": 1, "total": 1, "isLast": True}]}]
        for overrides in cases:
            with self.subTest(overrides=overrides), DisposableState() as state:
                store = state.create(CONFIG, FENCE, CREATED)
                with self.assertRaises(OfflineError):
                    scanner(store, fixture(overrides=overrides))[0].poll()
                self.assertEqual(store.state()["revision"], 0)
                self.assertEqual(store.counts()["processed_events"], 0)

    def test_history_total_drift_is_not_a_completed_scan(self):
        pages = [{"values": [history()], "startAt": 0, "total": 2, "isLast": False},
                 {"values": [], "startAt": 1, "total": 1, "isLast": True}]
        with DisposableState() as state:
            store = state.create(CONFIG, FENCE, CREATED)
            with self.assertRaisesRegex(OfflineError, "changed-restart"):
                scanner(store, fixture(overrides={"history:990100": pages}))[0].poll()
            self.assertIsNone(store.state()["full_upper"])

    def test_metadata_change_gets_full_reread_then_unstable_snapshot_holds(self):
        other = metadata(updated="2026-01-01T00:11:00Z")
        for reads, succeeds in (([metadata(), other], True), ([metadata(), other] * 3, False)):
            with self.subTest(succeeds=succeeds), DisposableState() as state:
                store = state.create(CONFIG, FENCE, CREATED)
                worker, _, transport, _ = scanner(store, fixture(overrides={"issue:990100": reads}))
                if succeeds:
                    worker.poll()
                    self.assertGreaterEqual(sum(op == "history" for op, _ in transport.calls), 2)
                else:
                    with self.assertRaisesRegex(OfflineError, "kept-changing"):
                        worker.poll()
                    self.assertEqual(store.state()["revision"], 0)

    def test_delayed_visibility_beyond_overlap_is_recovered_by_full_reconciliation(self):
        data = fixture([row(visible_at="2026-01-01T03:00:00Z")])
        with DisposableState() as state:
            store = state.create(CONFIG, FENCE, CREATED)
            worker, _, _, clock = scanner(store, data)
            worker.poll()
            worker.scan("incremental")
            for _ in range(3):
                clock.advance(3600)
                worker.scan("incremental")
            self.assertEqual(store.counts()["notification_outbox"], 0)
            worker.scan("full")
            self.assertEqual(store.counts()["notification_outbox"], 1)
            worker.scan("full")
            self.assertEqual(store.counts()["notification_outbox"], 1)

    def test_hourly_and_restart_poll_select_full_without_resetting_cursor(self):
        with DisposableState() as state:
            store = state.create(CONFIG, FENCE, CREATED)
            worker, _, _, clock = scanner(store)
            worker.poll()
            worker.poll()
            self.assertIsNotNone(store.state()["completed_upper"])
            before = store.state()["completed_upper"]
            clock.advance(3600)
            scan_id = worker.poll()
            self.assertEqual(store._db.execute("SELECT kind FROM scan_runs WHERE scan_id=?", (scan_id,)).fetchone()[0], "full")
            store.close()
            store = state.reopen(CONFIG)
            new_worker = scanner(store, clock=clock)[0]
            new_worker.poll()
            self.assertEqual(store.state()["completed_upper"], before)
            self.assertEqual(store.counts()["notification_outbox"], 1)

    def test_known_issue_disappearing_is_not_silently_deleted(self):
        with DisposableState() as state:
            store = state.create(CONFIG, FENCE, CREATED)
            worker, source, _, _ = scanner(store)
            worker.poll()
            before = store.state()["revision"]
            source.replace_fixture(fixture([]))
            with self.assertRaisesRegex(OfflineError, "coverage-gap"):
                worker.scan("full")
            self.assertEqual(store.state()["revision"], before)
            self.assertEqual(store.known_issues(), {"990100"})

    def test_overlap_windows_are_frozen_and_watermark_is_completed_bound_not_wall_clock(self):
        with DisposableState() as state:
            store = state.create(CONFIG, FENCE, CREATED)
            worker, _, _, clock = scanner(store)
            worker.poll()
            frozen = clock.now
            scan = worker.scan("incremental")
            plan = store._db.execute("SELECT * FROM scan_runs WHERE scan_id=?", (scan,)).fetchone()
            expected = stamp((frozen - timedelta(seconds=60)).replace(second=0, microsecond=0))
            self.assertEqual(plan["upper_bound"], expected)
            self.assertEqual(store.state()["completed_upper"], expected)
            self.assertLess(expected, stamp(clock.now))
            self.assertEqual(plan["lower_bound"], "2026-01-01T00:05:00.000000Z")

    def test_rate_limit_retry_after_jitter_and_restart_persistence(self):
        with DisposableState() as state:
            store = state.create(CONFIG, FENCE, CREATED)
            worker, _, transport, clock = scanner(store, failures=json.dumps([{"status": 429, "retry_after": 3600}]))
            start = clock.now
            worker.poll()
            times = [value for _, value in transport.calls]
            self.assertGreaterEqual((clock.now - start).total_seconds(), 3600)
            self.assertGreaterEqual(times[1], stamp(start + timedelta(seconds=3600)))
            for left, right in zip(times, times[1:]):
                from evidence_watcher.model import utc
                self.assertGreaterEqual((utc(right) - utc(left)).total_seconds(), 10)
            saved = store.state()["next_request"]
            store.close()
            store = state.reopen(CONFIG)
            worker, _, transport, _ = scanner(store, clock=clock)
            worker.poll()
            self.assertGreaterEqual(transport.calls[0][1], saved)

    def test_retry_ceiling_and_circuit_are_durable_without_busy_loop(self):
        with DisposableState() as state:
            store = state.create(CONFIG, FENCE, CREATED)
            clock = VirtualClock(NOW, (0.5,))
            for cycle in range(1, 4):
                worker, _, transport, _ = scanner(store, failures=json.dumps([{"status": 503}] * 5), clock=clock)
                with self.assertRaisesRegex(OfflineError, "cycle-deferred"):
                    worker.poll()
                self.assertEqual(len(transport.calls), 5)
                self.assertEqual(store.state()["retry_cycles"], cycle)
                self.assertEqual(store.state()["revision"], 0)
                self.assertIsNone(store.state()["full_upper"])
            self.assertGreaterEqual(store.state()["not_before"], stamp(clock.now + timedelta(seconds=300)))
            store.close()
            reopened = state.reopen(CONFIG)
            self.assertEqual(reopened.state()["retry_cycles"], 3)
            worker, _, transport, _ = scanner(reopened, failures=json.dumps([{"status": 503}] * 5), clock=clock)
            with self.assertRaisesRegex(OfflineError, "cycle-deferred"):
                worker.poll()
            self.assertEqual(len(transport.calls), 1)
            self.assertEqual(reopened.state()["retry_cycles"], 4)

    def test_permanent_responses_hold_not_refresh_or_fallback(self):
        for status in (400, 401, 403, 404):
            with self.subTest(status=status), DisposableState() as state:
                store = state.create(CONFIG, FENCE, CREATED)
                worker, _, transport, _ = scanner(store, failures=json.dumps([{"status": status}]))
                with self.assertRaisesRegex(OfflineError, "permanent-response"):
                    worker.poll()
                self.assertEqual(len(transport.calls), 1)
                self.assertEqual(store.state()["last_error"], "permanent-contract")
                self.assertEqual(store.state()["revision"], 0)

    def test_retry_header_and_clock_negatives(self):
        clock = VirtualClock(NOW)
        self.assertEqual(retry_seconds("360000", clock.now), 360000)
        self.assertEqual(retry_seconds(format_datetime(clock.now + timedelta(hours=2), usegmt=True), clock.now), 7200)
        for value in (None, "not-a-date", -1, float("inf"), True):
            self.assertEqual(retry_seconds(value, clock.now), 0)
        for value in (-1, float("inf"), True):
            with self.assertRaises(OfflineError):
                clock.advance(value)
        for step in (-60, 90000):
            with self.subTest(step=step), DisposableState() as state:
                store = state.create(CONFIG, FENCE, CREATED)
                worker, _, _, clock = scanner(store)
                worker.poll()
                clock.now += timedelta(seconds=step)
                with self.assertRaisesRegex(OfflineError, "clock-boundary-hold"):
                    worker.scan("full")

    def test_unrepresentable_retry_delay_holds_instead_of_truncating(self):
        with DisposableState() as state:
            store = state.create(CONFIG, FENCE, CREATED)
            worker, _, _, _ = scanner(store, failures=json.dumps([{"status": 429, "retry_after": 1e300}]))
            with self.assertRaisesRegex(OfflineError, "retry-delay-out-of-range"):
                worker.poll()
            self.assertEqual(store.state()["revision"], 0)
            self.assertIsNone(store.state()["completed_upper"])

    def test_live_like_or_subclass_collaborators_are_refused(self):
        class PretendTransport(FixtureTransport):
            pass
        with DisposableState() as state:
            store = state.create(CONFIG, FENCE, CREATED)
            source = FixtureSource(fixture())
            with self.assertRaisesRegex(OfflineError, "concrete-offline"):
                OfflineScanner(store, PretendTransport(source), VirtualClock(NOW))
            with self.assertRaises(OfflineError):
                FixtureSource({"url": "not-a-fixture"})
            with self.assertRaises(OfflineError):
                FixtureSource('{"issues":[],"url":"https://untrusted.invalid"}')


if __name__ == "__main__":
    unittest.main()
