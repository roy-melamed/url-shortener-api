"""Concrete memory-only source/transport/clock. No live adapter protocol/fallback."""
from datetime import datetime, timedelta, timezone
import json
import math
import re

from .model import FixtureConfig, OfflineError, classify, parse_issue, require, stamp, utc
from .store import FaultPlan, SimulationStore


def unique_object(pairs: list[tuple[str, object]]) -> dict:
    """JSON decoder supplies decoded keys at every depth, before dict creation."""
    keys = set()
    for key, _ in pairs:
        if key in keys:
            # Never put untrusted keys/values in the exception or its context.
            raise ValueError("duplicate-json-key")
        keys.add(key)
    return dict(pairs)


def literal_json(text: str):
    require(type(text) is str and len(text.encode()) <= 2 * 1024 * 1024, "fixture-size-invalid")
    try:
        return json.loads(text, object_pairs_hook=unique_object,
                          parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
    except (ValueError, RecursionError):
        raise OfflineError("fixture-json-invalid") from None


class VirtualClock:
    def __init__(self, now: str, jitter: tuple[float, ...] = (0.0,)):
        self.now = utc(now)
        require(type(jitter) is tuple and bool(jitter) and all(type(v) in {int, float}
                and math.isfinite(v) and 0 <= v <= 1 for v in jitter), "jitter-invalid")
        self._jitter, self._index = jitter, 0

    def advance(self, seconds: float) -> None:
        require(type(seconds) in {int, float} and math.isfinite(seconds) and seconds >= 0, "clock-step-invalid")
        try:
            self.now += timedelta(seconds=seconds)
        except OverflowError:
            raise OfflineError("clock-step-invalid") from None

    def fraction(self) -> float:
        value = self._jitter[self._index % len(self._jitter)]
        self._index += 1
        return value


class FixtureSource:
    """Accepts literal JSON data only, never URLs, file handles or callables."""
    def __init__(self, text: str):
        self.replace_fixture(text)

    def replace_fixture(self, text: str) -> None:
        data = literal_json(text)
        require(type(data) is dict and set(data) <= {"issues", "page_size", "overrides"}
                and type(data.get("issues")) is list, "fixture-source-invalid")
        require(type(data.get("page_size", 2)) is int and 1 <= data.get("page_size", 2) <= 100,
                "fixture-page-size-invalid")
        require(type(data.get("overrides", {})) is dict, "fixture-overrides-invalid")
        self._data = data

    def page(self, operation: str, query: dict, now: datetime):
        require(operation in {"search", "issue", "history"}, "fixture-operation-invalid")
        overrides = self._data.get("overrides", {})
        key = operation + (":" + query["issue_id"] if "issue_id" in query else "")
        if key in overrides and overrides[key]:
            require(type(overrides[key]) is list, "fixture-overrides-invalid")
            return overrides[key].pop(0)
        try:
            rows = self._data["issues"]
            if operation == "search":
                selected = [row["metadata"] for row in rows
                            if utc(row.get("visible_at", "2000-01-01T00:00:00Z")) <= now
                            and (query["lower"] is None or
                                 query["lower"] <= stamp(utc(row["metadata"]["fields"]["updated"])) <= query["upper"])]
                selected.sort(key=lambda raw: (raw["fields"]["updated"], raw["id"]))
                start = int(query["token"] or 0)
                size = self._data.get("page_size", 2)
                end = min(start + size, len(selected))
                return {"values": selected[start:end], "isLast": end == len(selected),
                        "nextPageToken": None if end == len(selected) else str(end)}
            row = next((row for row in rows if row["metadata"]["id"] == query["issue_id"]), None)
            require(row is not None, "fixture-coverage-gap")
            if operation == "issue":
                return row["metadata"]
            start = query["start"]
            history = row["histories"]
            size = self._data.get("page_size", 2)
            end = min(start + size, len(history))
            return {"values": history[start:end], "startAt": start, "total": len(history),
                    "isLast": end == len(history)}
        except (KeyError, TypeError, ValueError, IndexError):
            raise OfflineError("fixture-source-invalid") from None


class FixtureTransport:
    """Only reads FixtureSource memory. The name does NOT mean notification delivery."""
    def __init__(self, source: FixtureSource, failures: str = "[]"):
        require(type(source) is FixtureSource, "fixture-source-required")
        failures = literal_json(failures)
        require(type(failures) is list and all(type(row) is dict and set(row) <= {"status", "retry_after"}
                and type(row.get("status")) is int for row in failures), "fixture-failures-invalid")
        self._source, self._failures = source, failures
        self.calls: list[tuple[str, str]] = []  # operation + virtual time only, no identifiers/content

    def exchange(self, operation: str, query: dict, now: datetime):
        self.calls.append((operation, stamp(now)))
        if self._failures:
            return self._failures.pop(0), None
        return {"status": 200}, self._source.page(operation, query, now)


def retry_seconds(value: object, now: datetime) -> float:
    if type(value) in {int, float} and math.isfinite(value) and value >= 0:
        return float(value)
    if isinstance(value, str):
        if value.isascii() and value.isdigit() and len(value) <= 10:
            return float(value)
        match = re.fullmatch(r"(Mon|Tue|Wed|Thu|Fri|Sat|Sun), ([0-9]{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([0-9]{4}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) GMT", value)
        if match:
            try:
                day_name, day, month, year, hour, minute, second = match.groups()
                date = datetime(int(year), "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split().index(month) + 1,
                                int(day), int(hour), int(minute), int(second), tzinfo=timezone.utc)
                if date.weekday() == "Mon Tue Wed Thu Fri Sat Sun".split().index(day_name):
                    return max(0.0, (date - now).total_seconds())
            except (ValueError, OverflowError):
                pass
    return 0.0


class OfflineScanner:
    """Bounded simulated reconciliation; collaborators cannot be live adapters."""
    def __init__(self, store: SimulationStore, transport: FixtureTransport, clock: VirtualClock):
        require(type(store) is SimulationStore and type(transport) is FixtureTransport
                and type(clock) is VirtualClock, "concrete-offline-collaborators-required")
        self.store, self.transport, self.clock = store, transport, clock
        self._restart_reconcile = True

    def poll(self, fault: FaultPlan | None = None) -> str:
        state = self.store.state()
        if not state["baseline_complete"]:
            kind = "bootstrap"
        elif self._restart_reconcile or state["full_upper"] is None or \
                (self.clock.now - utc(state["full_upper"])).total_seconds() >= 3600:
            kind = "full"
        else:
            kind = "incremental"
        result = self.scan(kind, fault)
        self._restart_reconcile = False
        return result

    def request(self, operation: str, query: dict):
        # After three exhausted cycles, a later cycle gets one half-open probe,
        # not another burst. Only a fully applied scan clears the durable hold.
        budget = 1 if self.store.state()["retry_cycles"] >= 3 else 5
        for attempt in range(budget):
            slot = utc(self.store.request_slot(stamp(self.clock.now)))
            self.clock.advance(max(0, (slot - self.clock.now).total_seconds()))
            response, body = self.transport.exchange(operation, query, self.clock.now)
            status = response["status"]
            if status == 200:
                require(body is not None, "fixture-response-invalid")
                return body
            if status not in {408, 429, 500, 502, 503, 504}:
                self.store.defer(stamp(self.clock.now + timedelta(hours=1)), "permanent-contract")
                raise OfflineError("fixture-permanent-response")
            delay = max(retry_seconds(response.get("retry_after"), self.clock.now),
                        min(300, 2 * 2 ** attempt) * self.clock.fraction())
            try:
                retry_at = stamp(self.clock.now + timedelta(seconds=delay))
            except OverflowError:
                raise OfflineError("retry-delay-out-of-range") from None
            self.store.defer(retry_at,
                             "rate-limited" if status == 429 else "transient")
        cycles = self.store.state()["retry_cycles"] + 1
        delay = 300 if cycles >= 3 else 60
        self.store.defer(stamp(self.clock.now + timedelta(seconds=delay)), "cycle-exhausted", True)
        raise OfflineError("fixture-cycle-deferred")

    def _history(self, issue_id: str) -> list:
        start, rows, total, seen_pages, seen_ids = 0, [], None, set(), set()
        for _ in range(1000):
            page = self.request("history", {"issue_id": issue_id, "start": start})
            require(type(page) is dict and set(page) == {"values", "startAt", "total", "isLast"}, "history-page-invalid")
            require(type(page["values"]) is list and type(page["startAt"]) is int and page["startAt"] == start
                    and type(page["total"]) is int and 0 <= page["total"] <= 10000
                    and len(page["values"]) <= 100 and type(page["isLast"]) is bool, "history-page-invalid")
            signature = json.dumps(page["values"], sort_keys=True)
            require(signature not in seen_pages, "history-page-repeated")
            seen_pages.add(signature)
            require(all(type(row) is dict and isinstance(row.get("id"), str) for row in page["values"]), "history-page-invalid")
            page_ids = {row["id"] for row in page["values"]}
            require(page_ids.isdisjoint(seen_ids), "history-page-repeated")
            seen_ids.update(page_ids)
            require(total is None or page["total"] == total, "history-changed-restart-required")
            total = page["total"]
            end = start + len(page["values"])
            require(end <= total and page["isLast"] == (end == total)
                    and (bool(page["values"]) or page["isLast"]), "history-page-incomplete")
            rows.extend(page["values"])
            if page["isLast"]:
                return rows
            start = end
        raise OfflineError("history-page-budget")

    def scan(self, kind: str, fault: FaultPlan | None = None) -> str:
        state = self.store.state()
        require(kind in {"bootstrap", "incremental", "full"}, "scan-kind-invalid")
        require(kind != "incremental" or state["baseline_complete"] == 1, "baseline-required")
        if state["last_clock"]:
            difference = (self.clock.now - utc(state["last_clock"])).total_seconds()
            require(0 <= difference <= 86400, "clock-boundary-hold")
        frozen_now = self.clock.now
        upper = stamp((frozen_now - timedelta(seconds=60)).replace(second=0, microsecond=0))
        lower = None
        if kind == "incremental":
            lower = stamp(max(utc(self.store.fence).replace(second=0, microsecond=0),
                              utc(state["completed_upper"] or self.store.fence) - timedelta(minutes=15)))
            require(lower <= upper, "activation-window-not-ready")
        scan_id = self.store.begin_scan(kind, lower, upper)
        token, seen_tokens, candidates = None, set(), {}
        for _ in range(1000):
            page = self.request("search", {"lower": lower, "upper": upper, "token": token})
            require(type(page) is dict and set(page) == {"values", "isLast", "nextPageToken"}
                    and type(page["values"]) is list and len(page["values"]) <= 100
                    and type(page["isLast"]) is bool, "search-page-invalid")
            next_token = page["nextPageToken"]
            require((page["isLast"] and next_token is None) or
                    (not page["isLast"] and isinstance(next_token, str) and 0 < len(next_token) <= 128
                     and next_token not in seen_tokens and bool(page["values"])), "search-page-incomplete")
            previous_count = len(candidates)
            for raw in page["values"]:
                issue = parse_issue(raw, self.store.config)
                require(issue.issue_id not in candidates or candidates[issue.issue_id] == issue, "search-snapshot-conflict")
                candidates[issue.issue_id] = issue
            require(len(candidates) <= 10000 and (not page["values"] or len(candidates) > previous_count), "search-page-repeated")
            if page["isLast"]:
                break
            seen_tokens.add(next_token)
            token = next_token
        else:
            raise OfflineError("search-page-budget")
        ids = set(candidates)
        if kind != "incremental":
            ids |= self.store.known_issues()
        snapshots = []
        for issue_id in sorted(ids):
            # Always use direct current metadata and a full retained changelog,
            # then reread. Never filter candidates by current Done status.
            for reread in range(3):
                before = parse_issue(self.request("issue", {"issue_id": issue_id}), self.store.config)
                require(before.issue_id == issue_id, "issue-identity-mismatch")
                histories = self._history(issue_id)
                after = parse_issue(self.request("issue", {"issue_id": issue_id}), self.store.config)
                require(after.issue_id == issue_id, "issue-identity-mismatch")
                if before == after:
                    snapshots.append(classify(after, histories, self.store.config, self.store.fence, stamp(self.clock.now)))
                    break
            else:
                raise OfflineError("issue-kept-changing")
        # Memory staging is discarded on an interrupted scan; restart refetches
        # from page zero, never claims partial progress or advances the cursor.
        self.store.apply(scan_id, tuple(snapshots), stamp(self.clock.now), fault)
        return scan_id
