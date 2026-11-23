"""Fresh read-only verification; no journal writer, broker, or sink capability."""
from pathlib import Path
from .core import containment_plan, digest, require
from .journal import read_only


def source_digest():
    root = Path(__file__).resolve().parent
    return digest([path.read_text() for path in sorted(root.glob("*.py"))])


def verify_stop(sandbox, retained_digest, scope, epoch, probe):
    sandbox.check()
    body, tail = read_only(sandbox.root / "journal.sqlite3", retained_digest)
    c = body["control"]
    require(c["scope"] == scope and scope["source"] == source_digest(), "verifier-source-scope-mismatch")
    require(c["state"] in {"STOPPED", "EXPIRED"} and c["epoch"] == epoch, "verifier-state-epoch-mismatch")
    require(all(not row["active"] for row in body["reservations"].values()), "verifier-active-lease")
    require(all(row["state"] not in {"CLAIMED", "INFLIGHT"} for row in body["operations"].values()), "verifier-active-operation")
    require(all(row["state"] not in {"PLANNED", "CLAIMED", "INFLIGHT"} for row in body["issues"].values()), "verifier-active-queue")
    require(all(not row["eligible"] for row in body["issues"].values()), "verifier-eligible-queue")
    require(all(row["revoked"] for row in body["handles"].values()), "verifier-active-handle")
    receipts = [row["receipt"] for row in body["stops"].values() if row["receipt"].get("outcome") == "QUIESCENCE_RECORDED" and row["receipt"].get("epoch") == epoch]
    require(bool(receipts), "verifier-stop-receipt-missing")
    require(all(row.get("scope_plan") == containment_plan(c, body["handles"]) for row in receipts), "verifier-expiry-scope-mismatch")
    require(type(probe) is dict and probe.get("denied") is True and probe.get("reason") == "disabled" and probe.get("before") == tail == probe.get("after") and probe.get("sink_before") == probe.get("sink_after"), "verifier-admission-probe-failed")
    receipt = {"verified": True, "state": c["state"], "epoch": epoch, "generation": c["generation"], "session": c["session"], "fixture": scope["fixture"], "source": scope["source"], "policy": scope["policy"], "config": scope["config"], "scope": digest(scope), "hash": tail, "state_hash": digest(body), "probe": dict(probe), "external": "BLOCKED_UNEXECUTED", "authenticated": False}
    return {**receipt, "verification_hash": digest(receipt)}
