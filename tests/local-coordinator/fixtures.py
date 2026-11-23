"""Synthetic local identities only. No project/credential configuration discovery."""
from pathlib import Path
from tempfile import TemporaryDirectory
from local_coordinator.core import MockClock, digest, ns
from local_coordinator.control import MockControl, RecordingSink
from local_coordinator.journal import Sandbox

START = ns("2026-11-22T00:00:00Z")
REQUEST = "00000000-0000-4000-8000-000000000001"


class Fixture:
    def __init__(self, start=START, now=START):
        # Sibling disposable roots avoid races with repository-wide file scanners.
        self.temp = TemporaryDirectory(prefix="coordinator-tests-", dir=Path(__file__).resolve().parents[3])
        self.parent = Path(self.temp.name)
        self.parent.chmod(0o700)
        self.sandbox = Sandbox(self.parent, "mock-local-fsync")
        self.clock = MockClock(now, suspend_supported=True)
        self.scope = {"fixture": "mock-fixture", "source": "a" * 40, "policy": "b" * 64, "config": "c" * 64, "caller": "mock-roy", "session": "mock-session", "resources": {key: ["mock-" + key.replace("-", "") + "-1"] for key in ("repo", "actions", "workflows", "jira", "principals", "token-store", "resources")}}
        self.scope.update(issues=["mock-issue", "mock-other", "mock-a", "mock-b"] + ["mock-issue-" + str(i) for i in range(26)], runs=["mock-run", "mock-other-run"], credential_refs=["mock-handle"])
        source = Path(__file__).resolve().parents[2] / "tools/local-coordinator/src/local_coordinator"
        self.scope["source"] = digest([path.read_text() for path in sorted(source.glob("*.py"))])
        self.scope["policy"] = "fcfefeda98d1fff5b38d11db89634a2dc9417f6b6c461e689059c8b46efa8f5e"
        self.scope["config"] = digest({key:value for key,value in self.scope.items() if key != "config"})
        self.sink = RecordingSink()
        self.control = MockControl.initialize(self.sandbox, self.scope, start, self.clock, self.sink)
        self.journals = [self.control._journal]

    def arm(self):
        self.control.arm_mock(self.scope["caller"])
        return self.control

    def claim(self, issue="mock-issue", run="mock-run", **cost):
        if issue not in self.control._journal.body["issues"]:
            self.prepare(issue)
        return self.control.claim(issue, "review", digest(issue), run, **cost)

    def prepare(self, name="mock-issue", stage="review", fingerprint=None):
        rows = dict((self.control._journal.body["snapshot"] or {"issues": {}})["issues"])
        rows[name] = issue(stage, fingerprint=fingerprint or digest(name))
        return self.control.plan({"complete": True, "issues": rows})

    def completion(self, fence):
        expected, record = evidence()
        expected.update(operation=fence[3], token=self.control._journal.body["operations"][fence[3]]["token"], fingerprint=fence[4], source_hash=self.scope["source"])
        record.update(fingerprint=expected["fingerprint"], source_hash=expected["source_hash"])
        record["final"].update(expected)
        return expected, record

    def finish(self, fence):
        expected, record = self.completion(fence)
        return self.control.finish(fence, "mock-evidence", expected, record)

    def sandbox_new(self):
        return Sandbox(self.parent, "mock-local-fsync")

    def reopen(self):
        journal = self.control._journal
        tail = journal.tail
        journal.close()
        self.control = MockControl.reopen(self.sandbox, self.scope, self.clock, self.sink, tail)
        self.journals.append(self.control._journal)
        return self.control

    def close(self):
        for journal in self.journals:
            journal.close()
        self.temp.cleanup()


def issue(stage="implementation", dependencies=None, outcome="PENDING", fingerprint=None):
    return {"stage": stage, "dependencies": dependencies or [], "outcome": outcome, "fingerprint": fingerprint or digest(stage)}


def evidence():
    expected = {"head": "1" * 40, "base": "2" * 40, "test_merge": "3" * 40, "merged": "4" * 40, "session": "mock-session", "pane": "mock-pane", "operation": "5" * 64, "token": "6" * 64, "artifact": "mock-artifact"}
    expected.update(fingerprint="7" * 64, source_hash="8" * 64)
    record = {"source": "synthetic", "final": {**expected, "kind": "final", "role": "dwight"}, "verdict": "PASS", "review": "COMMENT", "technical": "PASS", "head": expected["head"], "base": expected["base"], "test_merge": expected["test_merge"], "checks": {key: {"status": "completed", "conclusion": "success", "head": expected["head"], "base": expected["base"], "test_merge": expected["test_merge"]} for key in ("lint", "typecheck", "tests", "build")}, "merged": expected["merged"], "main": expected["merged"], "tested": expected["merged"], "qa_role": "pam"}
    record.update(fingerprint=expected["fingerprint"], source_hash=expected["source_hash"])
    return expected, record
