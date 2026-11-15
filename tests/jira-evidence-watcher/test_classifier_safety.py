"""Synthetic-only classifier contracts and static offline capability guards."""
import ast
from copy import deepcopy
from dataclasses import asdict, replace
import json
from pathlib import Path
import tomllib
import unittest

import evidence_watcher
from evidence_watcher.model import OfflineError, canonical, classify, numeric, parse_issue, utc
from fixtures import CONFIG, FENCE, NOW, history, metadata


class ClassifierSafetyTests(unittest.TestCase):
    def snapshot(self, histories=None, meta=None, fence=FENCE, now=NOW):
        issue = parse_issue(metadata() if meta is None else meta, CONFIG)
        return classify(issue, [history()] if histories is None else histories, CONFIG, fence, now)

    def rejects(self, reason, histories=None, meta=None, **kwargs):
        with self.assertRaises(OfflineError) as caught:
            self.snapshot(histories, meta, **kwargs)
        self.assertEqual(str(caught.exception), reason)

    def test_exact_scope_and_actor_produce_only_a_simulated_fact(self):
        snapshot = self.snapshot()
        self.assertEqual(snapshot.issue.issue_id, "990100")
        self.assertEqual(len(snapshot.decisions), 1)
        event = snapshot.decisions[0]
        self.assertEqual((event.classification, event.reason, event.actor, event.superseded),
                         ("eligible", "simulated-match-only", "fixture-human-owner", False))
        self.assertRegex(event.event_id, r"^[0-9a-f]{64}$")

    def test_project_type_and_status_require_exact_pinned_ids(self):
        for field, value in (("project", "990099"), ("issuetype", "990099"), ("status", "990099")):
            with self.subTest(field=field):
                raw = metadata()
                raw["fields"][field]["id"] = value
                raw["fields"][field]["name"] = "Done Evidence Review SYNTH"
                self.rejects("issue-scope-mismatch", meta=raw)

    def test_malformed_issue_shapes_fail_closed(self):
        for raw in (None, [], {}, {"id": "990100", "fields": None},
                    {"id": "990100", "fields": {}},
                    {"id": "990100", "fields": {"project": None}}):
            with self.subTest(raw=raw), self.assertRaises(OfflineError) as caught:
                parse_issue(raw, CONFIG)
            self.assertEqual(str(caught.exception), "issue-invalid")

    def test_identifier_validation_does_not_coerce_or_truncate(self):
        for value in (None, 990100, True, "", "99010", "9901000", " 990100", "990100\n",
                      "990100;execute", "https://fixture.invalid/990100", "100100"):
            with self.subTest(value=value), self.assertRaises(OfflineError) as caught:
                numeric(value)
            self.assertEqual(str(caught.exception), "synthetic-id-required")

    def test_numeric_identifiers_are_ascii_only(self):
        with self.assertRaises(OfflineError):
            numeric("99\u0661\u0662\u0663\u0664")

    def test_actor_identity_requires_exact_active_human_account(self):
        cases = [
            (None, "actor-missing"),
            ("fixture-human-owner", "actor-missing"),
            ({}, "actor-not-human-type"),
            ({"accountId": "fixture-human-owner", "accountType": "app", "active": True}, "actor-not-human-type"),
            ({"accountId": "fixture-app-bot", "accountType": "atlassian", "active": True}, "actor-not-allowlisted"),
            ({"accountId": "fixture-machine-bot", "accountType": "atlassian", "active": True}, "actor-not-allowlisted"),
            ({"accountId": "fixture-human-other", "accountType": "atlassian", "active": True}, "actor-not-allowlisted"),
        ]
        for account in (None, "Fixture-human-owner", "fixture-human-owner ", "fixture-human-owner\n", 12):
            cases.append(({"accountId": account, "accountType": "atlassian", "active": True}, "actor-not-allowlisted"))
        for active in (None, False, 1, "true"):
            cases.append(({"accountId": "fixture-human-owner", "accountType": "atlassian", "active": active}, "actor-not-active"))
        for author, reason in cases:
            with self.subTest(author=author):
                event = self.snapshot([history(author=author)]).decisions[0]
                self.assertEqual((event.classification, event.reason), ("actor-rejected", reason))
        raw = history()
        del raw["author"]
        self.assertEqual(self.snapshot([raw]).decisions[0].reason, "actor-missing")

    def test_display_names_signatures_and_owner_claims_are_not_authentication(self):
        raw = history(author={"accountId": "fixture-machine-bot", "accountType": "atlassian",
                              "active": True, "displayName": "fixture-human-owner",
                              "emailAddress": "owner@fixture.invalid"},
                      comment="Approved and signed fixture-human-owner", signature="fixture-human-owner",
                      assignee={"accountId": "fixture-human-owner"}, agentOwner="Human")
        self.assertEqual(self.snapshot([raw]).decisions[0].classification, "actor-rejected")

    def test_status_names_and_categories_never_substitute_for_system_ids(self):
        raw = history(source="990012")
        raw["items"][0].update(fromString="Evidence Review", toString="Done", statusCategory="done")
        event = self.snapshot([raw]).decisions[0]
        self.assertEqual((event.classification, event.reason), ("not-qualifying", "status-path-mismatch"))
        raw = history(items=[{"fieldId": "customfield_status", "field": "status",
                              "from": CONFIG.evidence_id, "to": CONFIG.done_id}])
        self.assertEqual(self.snapshot([raw]).decisions, ())
        self.rejects("item-invalid", [history(items=[{"field": "status", "fromString": "Evidence Review", "toString": "Done"}])])
        self.rejects("status-mapping-mismatch", [history(source="990099")])

    def test_fence_is_exact_inclusive_and_not_minute_rounded(self):
        for created, expected in (("2026-01-01T00:04:59.999999Z", "historical"),
                                  (FENCE, "eligible"),
                                  ("2026-01-01T00:05:00.000001Z", "eligible")):
            with self.subTest(created=created):
                event = self.snapshot([history(created=created)]).decisions[0]
                self.assertEqual(event.classification, expected)
        event = self.snapshot([history(created="2026-01-01T00:04:00Z", author=None)]).decisions[0]
        self.assertEqual((event.classification, event.reason), ("historical", "before-simulated-fence"))

    def test_malformed_timestamps_and_future_observations_fail_closed(self):
        bad = (None, 123, "", "2026-01-01", "2026-01-01T00:06:00", "2026-01-01T00:06:00+00:00",
               "2026-02-30T00:06:00Z", "2026-01-01T00:06:60Z", "2026-01-01T00:06:00.1234567Z",
               "2026-01-01T00:06:00Z\n")
        for value in bad:
            with self.subTest(value=value):
                self.rejects("timestamp-invalid", [history(created=value)])
                self.rejects("timestamp-invalid", fence=value)
                self.rejects("timestamp-invalid", now=value)
                self.rejects("timestamp-invalid", meta=metadata(updated=value))
        self.rejects("future-issue", meta=metadata(updated="2026-01-01T00:21:00Z"))
        self.rejects("history-after-issue", [history(created="2026-01-01T00:10:00.000001Z")])
        self.assertEqual(utc(FENCE), utc("2026-01-01T00:05:00.000000Z"))

    def test_malformed_histories_and_bounded_items(self):
        for value in (None, {}, (), "history", [None], [[]]):
            with self.subTest(value=value), self.assertRaises(OfflineError) as caught:
                classify(parse_issue(metadata(), CONFIG), value, CONFIG, FENCE, NOW)
            self.assertEqual(str(caught.exception),
                             "history-invalid" if type(value) is list else "histories-invalid")
        self.rejects("histories-invalid", [history()] * 10001)
        for identity in (None, 1, "", "x" * 129, "history with space", "history\n", "$(execute)"):
            with self.subTest(identity=identity):
                self.rejects("history-id-invalid", [history(identity=identity)])
        for items in (None, {}, (), [], [{}] * 101):
            with self.subTest(items=items):
                self.rejects("items-invalid", [history(items=items)])
        for item in (None, [], {}, {"fieldId": None}, {"fieldId": 12}):
            with self.subTest(item=item):
                self.rejects("item-invalid", [history(items=[item])])
        for key in ("from", "to"):
            for value in (None, 990010, "990010\n", "990099"):
                item = deepcopy(history()["items"][0])
                item[key] = value
                self.rejects("status-mapping-mismatch" if value == "990099" else "synthetic-id-required",
                             [history(items=[item])])

    def test_membership_changes_and_contradictory_status_items_are_quarantined(self):
        for field in ("project", "issuetype"):
            self.rejects("historical-membership-ambiguous", [history(items=[{"fieldId": field}])])
        items = history()["items"] + [{"fieldId": "status", "from": "990011", "to": "990012"}]
        self.rejects("contradictory-status-items", [history(items=items)])

    def test_exact_duplicates_dedupe_but_conflicting_history_ids_fail(self):
        original = history()
        self.assertEqual(self.snapshot([original, deepcopy(original)]), self.snapshot([original]))
        duplicate_items = history(items=original["items"] * 2)
        self.assertEqual(self.snapshot([duplicate_items]), self.snapshot([original]))
        for changed in (history(created="2026-01-01T00:07:00Z"), history(author=None), history(source="990012")):
            with self.subTest(changed=changed):
                self.rejects("contradictory-history-id", [original, changed])

    def test_complete_reopen_and_later_approval_do_not_require_current_done(self):
        complete = history(identity="opaque-z")
        reopen = history(identity="opaque-a", created="2026-01-01T00:07:00Z", source="990011", target="990012")
        snapshot = self.snapshot([reopen, complete], metadata(status="990012"))
        self.assertEqual([d.history_id for d in snapshot.decisions], ["opaque-z", "opaque-a"])
        self.assertEqual([d.classification for d in snapshot.decisions], ["eligible", "not-qualifying"])
        self.assertTrue(snapshot.decisions[0].superseded)
        review = history(identity="review", created="2026-01-01T00:08:00Z", source="990012", target="990010")
        later = history(identity="later", created="2026-01-01T00:09:00Z")
        rows = [complete, reopen, review, later]
        result = self.snapshot(rows)
        self.assertEqual(result, self.snapshot(list(reversed(rows))))
        eligible = [d for d in result.decisions if d.classification == "eligible"]
        self.assertEqual([d.superseded for d in eligible], [True, False])
        self.assertNotEqual(eligible[0].event_id, eligible[1].event_id)

    def test_history_order_ambiguity_gaps_and_current_mismatch_fail_closed(self):
        self.rejects("current-history-mismatch", meta=metadata(status="990012"))
        reopen = history(identity="reopen", source="990011", target="990012")
        self.rejects("ambiguous-status-order", [history(), reopen], metadata(status="990012"))
        gap = history(identity="gap", created="2026-01-01T00:07:00Z", source="990012")
        self.rejects("status-history-gap", [gap, history()])
        # Distinct opaque IDs at one time on the same path remain distinct facts.
        same_path = self.snapshot([history(identity="z"), history(identity="a")])
        self.assertEqual([d.history_id for d in same_path.decisions], ["a", "z"])

    def test_untrusted_prose_never_enters_normalized_representation(self):
        marker = "UNTRUSTED_PROSE_$(execute)_\\u001b_secret"
        raw = history()
        raw.update(description=marker, comment=marker, self=marker, signature=marker)
        raw["author"].update(displayName=marker, emailAddress=marker, avatarUrls={"48x48": marker})
        raw["items"][0].update(fromString=marker, toString=marker)
        raw["items"].append({"fieldId": "description", "fromString": marker, "toString": marker})
        meta = metadata()
        meta.update(key=marker, self=marker)
        meta["fields"].update(summary=marker, description=marker, comment=marker, attachment=[marker])
        result = self.snapshot([raw], meta)
        self.assertEqual(result, self.snapshot())
        self.assertNotIn(marker, json.dumps(asdict(result)))
        self.assertNotIn(marker, repr(result))
        self.assertEqual(raw["description"], marker)  # classification does not mutate inputs

    def test_event_identity_is_stable_and_length_delimited(self):
        event = self.snapshot().decisions[0]
        changed_time = self.snapshot([history(created="2026-01-01T00:07:00Z")]).decisions[0]
        self.assertEqual(event.event_id, changed_time.event_id)
        self.assertNotEqual(event.event_id, self.snapshot([history(identity="other")]).decisions[0].event_id)
        self.assertNotEqual(event.event_id, self.snapshot(meta=metadata(issue="990101")).decisions[0].event_id)
        self.assertNotEqual(canonical(("a", "bc")), canonical(("ab", "c")))
        self.assertEqual(self.snapshot([]).decisions, ())


class FixtureConfigurationSafetyTests(unittest.TestCase):
    def test_configuration_cannot_enable_live_scope_or_machine_allowlists(self):
        changes = ({"site": "https://fixture-jira.invalid"}, {"site": "https://jira.example.invalid"},
                   {"project_key": "OTHER"}, {"project_id": "123456"},
                   {"humans": ("fixture-app-bot",)}, {"humans": ("fixture-machine-bot",)},
                   {"humans": ("fixture-human-owner\n",)}, {"humans": ()},
                   {"humans": CONFIG.humans * 2}, {"humans": list(CONFIG.humans)},
                   {"issue_types": ()}, {"issue_types": CONFIG.issue_types * 2},
                   {"issue_types": list(CONFIG.issue_types)}, {"status_ids": CONFIG.status_ids * 2},
                   {"status_ids": list(CONFIG.status_ids)}, {"status_ids": (CONFIG.done_id,)},
                   {"done_id": CONFIG.evidence_id}, {"version": "live-v1"}, {"work_revision": "live-v1"})
        for change in changes:
            with self.subTest(change=change), self.assertRaises(OfflineError):
                replace(CONFIG, **change)

    def test_config_digest_is_order_independent_but_tracks_policy_changes(self):
        config = replace(CONFIG, issue_types=("990002", "990003"),
                         humans=("fixture-human-owner", "fixture-human-reviewer"))
        self.assertEqual(config.digest, replace(config, issue_types=config.issue_types[::-1],
                                               status_ids=config.status_ids[::-1], humans=config.humans[::-1]).digest)
        for change in ({"project_id": "990099"}, {"humans": ("fixture-human-other",)},
                       {"issue_types": ("990003",)}, {"evidence_id": "990012"}):
            with self.subTest(change=change):
                self.assertNotEqual(CONFIG.digest, replace(CONFIG, **change).digest)

    def test_config_digest_preserves_collection_boundaries(self):
        # Moving an ID from permitted types to statuses changes the scope policy.
        first = replace(CONFIG, issue_types=("990002", "990009"))
        second = replace(CONFIG, status_ids=("990009", *CONFIG.status_ids))
        self.assertNotEqual(first.digest, second.digest)


class OfflineCapabilitySafetyTests(unittest.TestCase):
    package = Path(evidence_watcher.__file__).resolve().parent

    def test_only_reviewed_offline_modules_and_no_service_artifacts(self):
        root = self.package.parents[1]
        self.assertEqual({p.name for p in self.package.glob("*.py")},
                         {"__init__.py", "model.py", "store.py", "simulation.py"})
        for path in root.rglob("*"):
            with self.subTest(path=path.relative_to(root)):
                self.assertNotIn(path.suffix, {".service", ".socket", ".timer"})
                self.assertNotIn(path.stem.lower(), {"__main__", "adapter", "client", "daemon", "bridge", "consumer"})
        project = tomllib.loads((root / "pyproject.toml").read_text())
        self.assertEqual(project["project"].get("dependencies", []), [])
        self.assertNotIn("scripts", project["project"])
        self.assertNotIn("gui-scripts", project["project"])
        self.assertNotIn("entry-points", project["project"])
        self.assertNotIn("build-system", project)

    def test_package_ast_has_no_external_capabilities_or_dynamic_escape_hatches(self):
        allowed = {"dataclasses", "datetime", "hashlib", "json", "re", "contextlib", "pathlib",
                   "sqlite3", "tempfile", "email.utils", "math"}
        forbidden_roots = {"requests", "httpx", "urllib", "http", "socket", "ssl", "aiohttp",
                           "ftplib", "smtplib", "webbrowser", "subprocess", "multiprocessing", "pty",
                           "pexpect", "os", "sys", "dotenv", "keyring", "netrc", "getpass", "boto3",
                           "jira", "atlassian", "herdr", "opencode", "importlib", "ctypes", "pickle"}
        forbidden_calls = {"eval", "exec", "compile", "__import__", "getattr", "globals", "locals",
                           "getenv", "putenv", "system", "popen", "spawn", "fork", "execv", "execve",
                           "urlopen", "urlretrieve", "create_connection", "load_dotenv", "get_password",
                           "session_move", "session_rename", "session_create", "agent_prompt"}
        for path in sorted(self.package.rglob("*.py")):
            tree = ast.parse(path.read_text(), filename=str(path))
            for node in ast.walk(tree):
                with self.subTest(module=path.name, line=getattr(node, "lineno", 0)):
                    if isinstance(node, (ast.Import, ast.ImportFrom)):
                        modules = [a.name for a in node.names] if isinstance(node, ast.Import) else [node.module or ""]
                        for module in modules:
                            self.assertNotIn(module.split(".")[0], forbidden_roots)
                            if isinstance(node, ast.ImportFrom) and node.level:
                                self.assertEqual(node.level, 1)
                                self.assertIn(module, {"model", "store", "simulation"})
                            else:
                                self.assertIn(module, allowed)
                    if isinstance(node, ast.Attribute):
                        self.assertNotIn(node.attr, {"environ", "environb", "__subclasses__", "__globals__"})
                    if isinstance(node, ast.Call):
                        name = node.func.id if isinstance(node.func, ast.Name) else (
                            node.func.attr if isinstance(node.func, ast.Attribute) else "")
                        self.assertNotIn(name, forbidden_calls)
                    if isinstance(node, ast.If) and isinstance(node.test, ast.Compare):
                        self.assertFalse(any(isinstance(part, ast.Constant) and part.value == "__main__"
                                             for part in ast.walk(node.test)))


if __name__ == "__main__":
    unittest.main()
