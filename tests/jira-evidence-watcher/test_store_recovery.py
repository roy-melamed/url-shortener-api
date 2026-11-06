import contextlib
import io
import json
import sqlite3
import unittest
from dataclasses import replace

from evidence_watcher.model import OfflineError, classify, parse_issue
from evidence_watcher.store import DisposableState, FaultPlan, InjectedCrash
from fixtures import CONFIG, CREATED, FENCE, NOW, fixture, history, metadata, row, scanner


class StoreRecoveryTests(unittest.TestCase):
    def test_bootstrap_suppresses_old_but_captures_during_slow_baseline(self):
        histories = [history("old", "2026-01-01T00:04:00Z"),
                     history("review", "2026-01-01T00:04:30Z", "990011", "990010"), history()]
        with DisposableState() as state:
            store = state.create(CONFIG, FENCE, CREATED)
            worker, _, _, _ = scanner(store, fixture([row(histories=histories)]))
            worker.poll()
            self.assertEqual(store.counts()["processed_events"], 3)
            self.assertEqual(store.counts()["notification_outbox"], 1)
            self.assertEqual(store.fence, "2026-01-01T00:05:00.000000Z")
            for _ in range(3):
                worker.scan("full")
            self.assertEqual(store.counts()["notification_outbox"], 1)

    def test_history_older_than_fence_never_replays_after_restart(self):
        data = fixture([row(histories=[history(created="2026-01-01T00:04:00Z")])])
        with DisposableState() as state:
            store = state.create(CONFIG, FENCE, CREATED)
            worker, _, _, clock = scanner(store, data)
            worker.poll()
            store.close()
            store = state.reopen(CONFIG)
            scanner(store, data, clock=clock)[0].poll()
            self.assertEqual(store.counts()["processed_events"], 1)
            self.assertEqual(store.counts()["notification_outbox"], 0)

    def test_fence_immutable_and_config_cannot_silently_expand(self):
        with DisposableState() as state:
            store = state.create(CONFIG, FENCE, CREATED)
            with self.assertRaises(AttributeError):
                store.fence = CREATED
            with self.assertRaises(AttributeError):
                store.config = replace(CONFIG, humans=("fixture-human-other",))
            for sql in ("UPDATE installation SET fence='2099-01-01T00:00:00Z'", "DELETE FROM installation"):
                with self.assertRaises(sqlite3.IntegrityError):
                    store._db.execute(sql)
            with self.assertRaisesRegex(OfflineError, "state-config-mismatch"):
                state.reopen(replace(CONFIG, humans=("fixture-human-other",)))
            self.assertEqual(store.fence, "2026-01-01T00:05:00.000000Z")
            with self.assertRaisesRegex(OfflineError, "future-fence"):
                state.create(CONFIG, CREATED, CREATED)

    def test_no_automatic_reset_when_missing_corrupt_wrong_schema_or_existing(self):
        with DisposableState() as state:
            with self.assertRaisesRegex(OfflineError, "state-missing"):
                state.reopen(CONFIG)
            self.assertFalse((state.directory / "events.sqlite3").exists())
            store = state.create(CONFIG, FENCE, CREATED)
            with self.assertRaisesRegex(OfflineError, "no-reset"):
                state.create(CONFIG, FENCE, CREATED)
            store._db.execute("PRAGMA user_version=2")
            with self.assertRaisesRegex(OfflineError, "state-schema"):
                state.reopen(CONFIG)
            store.close()
            path = state.directory / "events.sqlite3"
            path.write_bytes(b"deliberately corrupt disposable fixture")
            before = path.read_bytes()
            with self.assertRaisesRegex(OfflineError, "no-reset"):
                state.reopen(CONFIG)
            self.assertEqual(path.read_bytes(), before)

    def test_event_identity_independent_of_fence_install_and_scan(self):
        first = classify(parse_issue(metadata(), CONFIG), [history()], CONFIG, FENCE, NOW)
        later_fence = "2026-01-01T00:07:00Z"
        second = classify(parse_issue(metadata(), CONFIG), [history()], CONFIG, later_fence, NOW)
        self.assertEqual(first.decisions[0].event_id, second.decisions[0].event_id)
        self.assertNotEqual(first.decisions[0].classification, second.decisions[0].classification)

    def test_every_transaction_fault_boundary_is_all_or_nothing_and_recoverable(self):
        points = ("after-begin", "after-event", "after-outbox", "before-watermark",
                  "after-watermark", "before-commit", "after-commit")
        for point in points:
            with self.subTest(point=point), DisposableState() as state:
                store = state.create(CONFIG, FENCE, CREATED)
                worker, source, _, clock = scanner(store, fixture([]))
                worker.poll()
                source.replace_fixture(fixture())
                with self.assertRaises(InjectedCrash):
                    worker.scan("incremental", FaultPlan(point))
                store.close()
                store = state.reopen(CONFIG)
                committed = point == "after-commit"
                self.assertEqual(store.state()["completed_upper"] is not None, committed)
                self.assertEqual(store.counts()["notification_outbox"], int(committed))
                self.assertEqual(store.counts()["processed_events"], int(committed))
                self.assertEqual(store.state()["revision"], 2 if committed else 1)
                scanner(store, clock=clock)[0].poll()
                self.assertEqual(store.counts()["processed_events"], 1)
                self.assertEqual(store.counts()["notification_outbox"], 1)
                self.assertEqual(store.counts()["simulated_work_identities"], 1)

    def test_stale_scan_revision_cannot_commit_on_second_connection(self):
        with DisposableState() as state:
            first = state.create(CONFIG, FENCE, CREATED)
            second = state.reopen(CONFIG)
            scan_a = first.begin_scan("bootstrap", None, NOW)
            scan_b = second.begin_scan("bootstrap", None, NOW)
            snap = classify(parse_issue(metadata(), CONFIG), [history()], CONFIG, first.fence, NOW)
            first.apply(scan_a, (snap,), NOW)
            with self.assertRaisesRegex(OfflineError, "stale-scan"):
                second.apply(scan_b, (snap,), NOW)
            self.assertEqual(second.state()["revision"], 1)
            self.assertEqual(second.counts()["notification_outbox"], 1)

    def test_canonical_collision_and_foreign_key_fault_roll_back(self):
        with DisposableState() as state:
            store = state.create(CONFIG, FENCE, CREATED)
            snap = classify(parse_issue(metadata(), CONFIG), [history()], CONFIG, FENCE, NOW)
            store.apply(store.begin_scan("bootstrap", None, NOW), (snap,), NOW)
            malicious = replace(snap.decisions[0], history_id="another-history")
            forged = replace(snap, histories=(*snap.histories, ("another-history", "fixture-digest")), decisions=(malicious,))
            with self.assertRaisesRegex(OfflineError, "event-identity-conflict"):
                store.apply(store.begin_scan("full", None, NOW), (forged,), NOW)
            self.assertEqual(store.state()["revision"], 1)
            self.assertEqual(store.counts()["history_registry"], 1)
            with self.assertRaisesRegex(OfflineError, "storage-transaction-failed"):
                with store.transaction():
                    store._db.execute("INSERT INTO notification_outbox VALUES('missing','missing','{}','pending-offline')")
            self.assertEqual(store.counts()["notification_outbox"], 1)

    def test_workspace_cannot_be_retargeted_via_public_path_configuration(self):
        with DisposableState() as state:
            with self.assertRaises(AttributeError):
                state.directory = "/a-non-disposable-path"
            with self.assertRaises(TypeError):
                DisposableState("/a-non-disposable-path")

    def test_store_rechecks_fence_for_a_forged_normalized_decision(self):
        with DisposableState() as state:
            store = state.create(CONFIG, FENCE, CREATED)
            snap = classify(parse_issue(metadata(), CONFIG), [history(created="2026-01-01T00:04:00Z")], CONFIG, FENCE, NOW)
            forged = replace(snap, decisions=(replace(snap.decisions[0], classification="eligible", reason="simulated-match-only"),))
            with self.assertRaisesRegex(OfflineError, "event-decision-conflict"):
                store.apply(store.begin_scan("bootstrap", None, NOW), (forged,), NOW)
            self.assertEqual(store.state()["revision"], 0)
            self.assertEqual(store.counts()["notification_outbox"], 0)
            for bounds in ((None, "not-time"), (NOW, CREATED)):
                with self.assertRaises(OfflineError):
                    store.begin_scan("full", *bounds)

    def test_busy_writer_holds_cursor_instead_of_resetting(self):
        with DisposableState() as state:
            first = state.create(CONFIG, FENCE, CREATED)
            second = state.reopen(CONFIG)
            first._db.execute("BEGIN IMMEDIATE")
            try:
                with self.assertRaisesRegex(OfflineError, "storage-transaction-failed"):
                    second.begin_scan("full", None, NOW)
            finally:
                first._db.execute("ROLLBACK")
            self.assertEqual(second.state()["revision"], 0)
            self.assertIsNone(second.state()["completed_upper"])

    def test_later_approval_keeps_distinct_facts_but_one_simulated_work_identity(self):
        histories = [history(), history("reopen", "2026-01-01T00:07:00Z", "990011", "990012"),
                     history("review-again", "2026-01-01T00:08:00Z", "990012", "990010"),
                     history("approval-again", "2026-01-01T00:09:00Z")]
        with DisposableState() as state:
            store = state.create(CONFIG, FENCE, CREATED)
            worker = scanner(store, fixture([row(histories=histories)]))[0]
            worker.poll()
            worker.scan("full")
            self.assertEqual(store.counts()["notification_outbox"], 2)
            self.assertEqual(store.counts()["simulated_work_identities"], 1)
            self.assertEqual(len({r["event_id"] for r in store.inspect_outbox()}), 2)
            self.assertEqual(len({r["work_id"] for r in store.inspect_outbox()}), 1)
            superseded = store._db.execute("SELECT superseded FROM processed_events WHERE history_id='history-approval'").fetchone()[0]
            self.assertEqual(superseded, 1)

    def test_history_change_or_removal_cannot_advance_watermark(self):
        for alteration in ([], [history(created="2026-01-01T00:06:01Z")]):
            with self.subTest(alteration=alteration), DisposableState() as state:
                store = state.create(CONFIG, FENCE, CREATED)
                worker, source, _, _ = scanner(store)
                worker.poll()
                before = store.state()["revision"]
                source.replace_fixture(fixture([row(histories=alteration)]))
                with self.assertRaises(OfflineError):
                    worker.scan("full")
                self.assertEqual(store.state()["revision"], before)
                self.assertEqual(store.counts()["notification_outbox"], 1)

    def test_privacy_permissions_and_pending_records_have_no_delivery_surface(self):
        sentinel = "UNTRUSTED_SYNTHETIC_TEXT_NOT_FOR_STORAGE"
        raw_history = history()
        raw_history["author"]["displayName"] = sentinel
        raw_history["comment"] = sentinel
        meta = metadata()
        meta["fields"]["summary"] = sentinel
        with DisposableState() as state:
            store = state.create(CONFIG, FENCE, CREATED)
            captured = io.StringIO()
            with contextlib.redirect_stdout(captured), contextlib.redirect_stderr(captured):
                worker, _, transport, _ = scanner(store, fixture([row(meta, [raw_history])]))
                worker.poll()
            self.assertEqual(captured.getvalue(), "")
            self.assertNotIn(sentinel, "\n".join(store._db.iterdump()))
            self.assertNotIn(sentinel, repr(transport.calls))
            for record in store.inspect_outbox():
                self.assertEqual(record["state"], "pending-offline")
                self.assertEqual(set(json.loads(record["payload"])), {"kind", "event_id", "simulated_work_id"})
            self.assertFalse(any(hasattr(store, name) for name in ("send", "drain", "ack", "claim", "deliver")))
            self.assertEqual(state.directory.stat().st_mode & 0o777, 0o700)
            self.assertTrue(all(path.stat().st_mode & 0o777 == 0o600 for path in state.directory.iterdir()))


if __name__ == "__main__":
    unittest.main()
