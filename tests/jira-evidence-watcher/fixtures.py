"""Invented identities/times only; never imports project Jira/credential config."""
import json
from pathlib import Path
from evidence_watcher.model import FixtureConfig
from evidence_watcher.simulation import FixtureSource, FixtureTransport, OfflineScanner, VirtualClock

raw = json.loads(Path(__file__).with_name("fixture-config.json").read_text())
for key in ("issue_types", "status_ids", "humans"):
    raw[key] = tuple(raw[key])
CONFIG = FixtureConfig(**raw)
CREATED = "2026-01-01T00:00:00Z"
FENCE = "2026-01-01T00:05:00Z"
NOW = "2026-01-01T00:20:00Z"


def history(identity="history-approval", created="2026-01-01T00:06:00Z",
            source="990010", target="990011", **extra):
    return {"id": identity, "created": created,
            "author": {"accountId": "fixture-human-owner", "accountType": "atlassian", "active": True},
            "items": [{"fieldId": "status", "from": source, "to": target}], **extra}


def metadata(issue="990100", updated="2026-01-01T00:10:00Z", status="990011"):
    return {"id": issue, "fields": {"project": {"id": "990001"}, "issuetype": {"id": "990002"},
            "status": {"id": status}, "updated": updated}}


def row(meta=None, histories=None, **extra):
    return {"metadata": meta or metadata(), "histories": [history()] if histories is None else histories, **extra}


def fixture(rows=None, **extra):
    return json.dumps({"issues": [row()] if rows is None else rows, "page_size": 2, **extra})


def scanner(store, data=None, failures="[]", clock=None):
    clock = clock or VirtualClock(NOW)
    source = FixtureSource(data or fixture())
    transport = FixtureTransport(source, failures)
    return OfflineScanner(store, transport, clock), source, transport, clock
