import builtins
import contextlib
import io
import json
import os
from pathlib import Path
import sqlite3
import socket
import subprocess
import sys
import threading
import time
import types
import unittest
from unittest.mock import patch
from local_coordinator import core, control, journal, verifier
from local_coordinator.core import Blocked, DAY, SECOND, digest
from local_coordinator.control import MockControl
from local_coordinator.journal import Crash, Journal, read_only
from fixtures import Fixture, REQUEST, START, issue


class IsolationRecoveryTests(unittest.TestCase):
    def test_real_hung_gate_and_delayed_persistence_return_blocked_within_budget(self):
        for phase in ("gate", "persistence"):
            f = Fixture()
            release = threading.Event()
            try:
                f.arm()
                if phase == "gate":
                    f.control._gate.acquire()
                else:
                    original = f.control._journal.sync
                    def delayed_sync():
                        release.wait(8)
                        original()
                    f.control._journal.sync = delayed_sync
                start = time.monotonic()
                receipt = f.control.halt(REQUEST, f.scope["caller"])
                elapsed = time.monotonic() - start
                self.assertEqual(receipt["outcome"], "BLOCKED")
                self.assertFalse(f.control.enabled)
                self.assertLess(elapsed, 5.5)  # OS scheduling allowance, not a longer policy budget.
                with self.assertRaises(Blocked):
                    f.claim()
            finally:
                release.set()
                if phase == "gate":
                    f.control._gate.release()
                if f.control._stop_thread is not None:
                    f.control._stop_thread.join(3)
                    self.assertFalse(f.control._stop_thread.is_alive())
                f.close()

    def test_reconciliation_completion_retry_crash_boundaries_reopen_closed(self):
        for action in ("reconciliation", "completion", "retry"):
            for cut in ("before-commit", "after-commit"):
                f = Fixture()
                try:
                    f.arm()
                    fence = f.claim() if action != "reconciliation" else None
                    f.control._journal.fault = cut
                    with self.assertRaises(Crash):
                        if action == "reconciliation":
                            f.control.plan({"complete": True, "issues": {"mock-a": issue()}})
                        elif action == "completion":
                            f.finish(fence)
                        else:
                            f.control.retry(fence, "transient", True)
                    f.control._journal.fault = None
                    body, tail = read_only(f.control._journal.path)
                    f.control._journal.close()
                    reopened = MockControl.reopen(f.sandbox, f.scope, f.clock, f.sink, tail)
                    f.journals.append(reopened._journal)
                    self.assertFalse(reopened.enabled)
                    self.assertEqual(reopened._journal.body, body)
                    if action == "completion":
                        self.assertEqual(body["operations"][fence[3]]["state"], "COMPLETED" if cut == "after-commit" else "CLAIMED")
                    elif action == "retry":
                        self.assertEqual(body["operations"][fence[3]].get("failure_at"), f.clock.mono if cut == "after-commit" else None)
                    else:
                        self.assertEqual("mock-a" in body["issues"], cut == "after-commit")
                finally:
                    f.close()

    def test_selected_snapshot_restore_unions_newer_history_without_changing_original(self):
        f = Fixture()
        try:
            selected, candidate = f.sandbox_new(), f.sandbox_new()
            receipt = f.control.snapshot(selected, 0, f.scope["caller"])
            saved = (selected.root / "journal.sqlite3").read_bytes()
            f.arm()
            fence = f.claim()
            f.finish(fence)
            f.control.halt(REQUEST, f.scope["caller"])
            original = {p.name: p.read_bytes() for p in f.sandbox.root.iterdir() if p.name.endswith(("sqlite3", "-wal"))}
            result = f.control.rollback(selected, candidate, f.control._journal.body["control"]["epoch"], receipt, f.scope["caller"])
            restored, _ = read_only(candidate.root / "journal.sqlite3", result["tail"])
            self.assertEqual(restored["operations"], f.control._journal.body["operations"])
            self.assertEqual(restored["control"], f.control._journal.body["control"])
            self.assertEqual(restored["runs"], f.control._journal.body["runs"])
            self.assertEqual(saved, (selected.root / "journal.sqlite3").read_bytes())
            self.assertEqual(original, {p.name: p.read_bytes() for p in f.sandbox.root.iterdir() if p.name.endswith(("sqlite3", "-wal"))})
        finally:
            f.close()

    def test_job_timeout_equality_cancels_without_refunding_reservation(self):
        f = Fixture()
        try:
            f.arm()
            fence = f.claim()
            f.clock.advance(1800 * SECOND - 1)
            f.control.watchdog()
            f.clock.advance(1)
            with self.assertRaisesRegex(Blocked, "job-timeout"):
                f.control.effect(fence)
            self.assertFalse(f.control.enabled)
            self.assertEqual(f.sink.initiations, ())
            self.assertEqual(f.control._journal.body["minutes"]["2026-11"], 30)
            self.assertEqual(f.control._journal.body["storage"], 4096)
        finally:
            f.close()

    def test_imports_deny_all_external_capabilities_and_do_not_construct_threads_or_files(self):
        modules = (core, journal, control, verifier)
        source = [(module.__name__, Path(module.__file__).read_text()) for module in modules]
        original_import = builtins.__import__
        attempts = []
        def denied(*args, **kwargs):
            attempts.append("denied")
            raise AssertionError("capability-denied")
        def closed_import(name, globals=None, locals=None, fromlist=(), level=0):
            if level == 1 and name in {"core", "journal", "verifier"}:
                return sys.modules["local_coordinator." + name]
            if name not in {"dataclasses", "datetime", "hashlib", "json", "re", "pathlib", "contextlib", "os", "sqlite3", "tempfile", "threading", "time"}:
                return denied()
            return original_import(name, globals, locals, fromlist, level)
        class DeniedEnvironment(dict):
            __getitem__ = denied
            get = denied
            __iter__ = denied
            __contains__ = denied
        for name, code in source:
            probe = types.ModuleType(name + "_probe")
            probe.__package__ = "local_coordinator"
            sys.modules[probe.__name__] = probe
            try:
                with contextlib.ExitStack() as stack:
                    for target in ("builtins.open", "os.open", "os.mkdir", "os.makedirs", "os.getenv", "sqlite3.connect", "threading.Thread", "threading.Timer", "time.sleep", "time.time", "time.monotonic_ns", "socket.socket", "subprocess.Popen", "subprocess.run", "tempfile.mkdtemp", "tempfile.TemporaryDirectory"):
                        stack.enter_context(patch(target, denied))
                    stack.enter_context(patch("builtins.__import__", closed_import))
                    stack.enter_context(patch.object(os, "environ", DeniedEnvironment()))
                    exec(compile(code, "local-import-probe", "exec"), probe.__dict__)
                    if name.endswith(".core"):
                        self.assertEqual(probe.reconcile({"complete":True,"issues":{}},{}), {})
                        self.assertFalse(probe.reservation_fits(101,0,0,0,0))
                self.assertEqual(attempts, [])
            finally:
                del sys.modules[probe.__name__]

    def test_missing_corrupt_schema_and_audit_state_preserve_bytes_without_reset(self):
        f = Fixture()
        try:
            empty = f.sandbox_new()
            with self.assertRaises(Blocked):
                Journal(empty)
            self.assertEqual(list(empty.root.iterdir()), [])
            f.control._journal.close()
            path = f.sandbox.root / "journal.sqlite3"
            path.write_bytes(b"deliberately corrupt disposable local journal")
            before = path.read_bytes()
            with self.assertRaises(Blocked):
                Journal(f.sandbox)
            self.assertEqual(path.read_bytes(), before)
        finally:
            f.close()
        for mutation in ("PRAGMA user_version=2", "UPDATE state SET body='{}'", "DROP TRIGGER audit_no_update"):
            f = Fixture()
            try:
                f.control._journal.db.execute(mutation)
                before = {p.name:p.read_bytes() for p in f.sandbox.root.iterdir() if p.name.endswith(("sqlite3", "-wal"))}
                with self.assertRaises(Blocked):
                    read_only(f.control._journal.path, f.control._journal.tail)
                self.assertEqual(before, {p.name:p.read_bytes() for p in f.sandbox.root.iterdir() if p.name.endswith(("sqlite3", "-wal"))})
            finally:
                f.close()

    def test_crash_before_after_claim_commit_and_retry_reopen_default_disabled(self):
        for point in ("before-commit", "after-commit"):
            f = Fixture()
            try:
                f.arm()
                f.prepare()
                f.control._journal.fault = point
                with self.assertRaises(Crash):
                    f.claim()
                f.control._journal.fault = None
                _, retained = read_only(f.control._journal.path)
                f.control._journal.close()
                recovered = MockControl.reopen(f.sandbox, f.scope, f.clock, f.sink, retained)
                f.journals.append(recovered._journal)
                self.assertFalse(recovered.enabled)
                count = len(recovered._journal.body["operations"])
                self.assertEqual(count, 1 if point == "after-commit" else 0)
                if count:
                    self.assertEqual(recovered._journal.body["runs"]["mock-run"], 1)
                with self.assertRaises(Blocked):
                    recovered.claim("mock-issue", "review", digest("changed"), "mock-run")
            finally:
                f.close()

    def test_committed_wal_backup_and_corrupt_wal_are_not_silently_repaired(self):
        f = Fixture()
        try:
            f.control._journal.db.execute("PRAGMA wal_autocheckpoint=0")
            f.arm()
            fence = f.claim()
            wal = Path(str(f.control._journal.path) + "-wal")
            self.assertTrue(wal.is_file())
            self.assertGreater(wal.stat().st_size, 0)
            f.control.halt(REQUEST, f.scope["caller"])
            selected = f.sandbox_new()
            epoch = f.control._journal.body["control"]["epoch"]
            receipt = f.control.snapshot(selected, epoch, f.scope["caller"])
            saved, _ = read_only(selected.root / "journal.sqlite3", receipt["tail"])
            self.assertIn(fence[3], saved["operations"])
            self.assertFalse(f.control.enabled)
            raw = wal.read_bytes()
            corrupt = raw[:-1] + bytes([raw[-1] ^ 255])
            wal.write_bytes(corrupt)
            with self.assertRaises(Blocked):
                read_only(f.control._journal.path, f.control._journal.tail)
            self.assertEqual(wal.read_bytes(), corrupt)
            original_db = f.control._journal.path.read_bytes()
            f.control._journal.close()
            self.assertEqual(wal.read_bytes(), corrupt)
            self.assertEqual(f.control._journal.path.read_bytes(), original_db)
        finally:
            f.close()

    def test_scope_default_deny_symlink_and_unrelated_fixture_unchanged(self):
        f, other = Fixture(), Fixture()
        try:
            f.arm()
            tail = other.control._journal.tail
            for action in (lambda: f.control.claim("mock-not-allowed", "review", digest("x"), "mock-run"), lambda: f.control.claim("mock-issue", "review", digest("x"), "mock-not-allowed"), lambda: f.control.handle("mock-not-allowed", START, START, START + DAY), lambda: f.control.halt(REQUEST, "mock-unknown")):
                with self.assertRaises(Blocked):
                    action()
            self.assertEqual(other.control._journal.tail, tail)
            f.control.halt(REQUEST, f.scope["caller"])
            with self.assertRaises(Blocked):
                f.control.snapshot(other.sandbox, f.control._journal.body["control"]["epoch"], f.scope["caller"])
            self.assertFalse((other.sandbox.root / "quarantined").exists())
            empty = f.sandbox_new()
            (empty.root / "journal.sqlite3").symlink_to(other.control._journal.path)
            with self.assertRaises(Blocked):
                Journal(empty)
            self.assertEqual(other.control._journal.tail, tail)
        finally:
            f.close()
            other.close()

    def test_rollback_invalid_digest_quarantines_original_and_new_but_preserves_snapshot(self):
        f = Fixture()
        try:
            f.arm()
            f.control.halt(REQUEST, f.scope["caller"])
            epoch = f.control._journal.body["control"]["epoch"]
            selected, candidate = f.sandbox_new(), f.sandbox_new()
            receipt = f.control.snapshot(selected, epoch, f.scope["caller"])
            saved = (selected.root / "journal.sqlite3").read_bytes()
            with self.assertRaisesRegex(Blocked, "rollback-quarantined"):
                f.control.rollback(selected, candidate, epoch, {**receipt, "file_hash":"0" * 64}, f.scope["caller"])
            self.assertFalse(f.control.enabled)
            self.assertEqual(saved, (selected.root / "journal.sqlite3").read_bytes())
            self.assertTrue((f.sandbox.root / "quarantined").is_file())
            self.assertTrue((candidate.root / "quarantined").is_file())
            with self.assertRaises(Blocked):
                Journal(candidate)
        finally:
            f.close()

    def test_halt_latch_wins_while_gate_is_contended_two_clients_cannot_initiate(self):
        f = Fixture()
        try:
            f.arm()
            fence = f.claim()
            closed = threading.Event()
            clear = f.control._enabled.clear
            def observed_clear():
                clear()
                closed.set()
            f.control._enabled.clear = observed_clear
            f.control._gate.acquire()
            results = []
            def client():
                try:
                    f.control.effect(fence)
                except Blocked:
                    results.append("denied")
            clients = [threading.Thread(target=client) for _ in range(2)]
            for thread in clients:
                thread.start()
            receipt = []
            stopper = threading.Thread(target=lambda: receipt.append(f.control.halt(REQUEST, f.scope["caller"])))
            stopper.start()
            self.assertTrue(closed.wait(1))
            self.assertFalse(f.control.enabled)
            f.control._gate.release()
            for thread in clients + [stopper]:
                thread.join(3)
                self.assertFalse(thread.is_alive())
            self.assertEqual(results, ["denied", "denied"])
            self.assertEqual(f.sink.initiations, ())
            self.assertEqual(receipt[0]["outcome"], "LOCAL_STOPPED")
        finally:
            f.close()

    def test_all_quota_boundaries_no_counter_refund_and_stop_priority(self):
        f = Fixture()
        try:
            f.arm()
            rows = {"mock-issue-" + str(i):issue() for i in range(25)}
            f.control.plan({"complete":True, "issues":rows})
            self.assertEqual(len(f.control._journal.body["issues"]), 25)
            with self.assertRaises(Blocked):
                f.control.plan({"complete":True, "issues":{**rows,"mock-issue-25":issue()}})
            self.assertEqual(len(f.control._journal.body["issues"]), 25)
            self.assertEqual(f.control.halt(REQUEST, f.scope["caller"])["outcome"], "LOCAL_STOPPED")
        finally:
            f.close()

    def test_no_secrets_in_state_output_or_error_paths(self):
        f = Fixture()
        try:
            stdout, stderr = io.StringIO(), io.StringIO()
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                for value in ("ghp_PRIVATE_SECRET", "https://production.invalid/?PRIVATE", "PRIVATE password"):
                    with self.assertRaises(Blocked) as error:
                        f.control.handle(value, None, None, None)
                    self.assertNotIn("PRIVATE", str(error.exception))
                f.arm()
                receipt = f.control.halt(REQUEST, f.scope["caller"])
            self.assertEqual(stdout.getvalue() + stderr.getvalue(), "")
            self.assertNotIn("PRIVATE", json.dumps(receipt) + canonical_state(f))
        finally:
            f.close()

    def test_clock_faults_close_memory_and_persist_stop_without_normal_effect(self):
        for field, value in (("utc", START - 1), ("mono", -1), ("utc", START + SECOND + 1), ("boot", "mock-other"), ("suspend_supported", False)):
            f = Fixture()
            try:
                f.arm()
                fence = f.claim()
                setattr(f.clock, field, value)
                with self.assertRaises(Blocked):
                    f.control.effect(fence)
                self.assertFalse(f.control.enabled)
                self.assertEqual(f.control._journal.body["control"]["state"], "STOPPED")
                self.assertEqual(f.sink.initiations, ())
            finally:
                f.close()

    def test_mock_control_shape_and_unknown_credential_times_default_deny(self):
        f = Fixture()
        try:
            for command in ("enable", "unlock", "dispatch", "restore"):
                with self.assertRaises(Blocked):
                    f.control.invoke(command, {"fixture_root":str(f.sandbox.root), "fixture_id":f.scope["fixture"], "caller":f.scope["caller"]})
            f.arm()
            with self.assertRaises(Blocked):
                f.control.handle("mock-handle", None, START, START + DAY)
            self.assertFalse(f.control.enabled)
            self.assertEqual(f.control._journal.body["handles"], {})
            result = f.control.invoke("halt", {"fixture_root":str(f.sandbox.root), "fixture_id":f.scope["fixture"], "caller":f.scope["caller"], "operator":"roy", "request_id":REQUEST, "reason":"manual"})
            self.assertEqual(result["outcome"], "LOCAL_STOPPED")
        finally:
            f.close()


def canonical_state(fixture):
    return fixture.control._journal.db.execute("SELECT group_concat(body) FROM audit").fetchone()[0]
