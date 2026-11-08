"""Literal (not dict-built) ambiguous JSON must never reach classification/storage."""
import contextlib
import io
import json
import traceback
import unittest
from unittest.mock import patch

from evidence_watcher.model import OfflineError
from evidence_watcher.simulation import FixtureSource, FixtureTransport, OfflineScanner, VirtualClock, literal_json
from evidence_watcher.store import DisposableState
from fixtures import CONFIG, CREATED, FENCE, NOW, fixture


def ambiguous_fixtures():
    # Keep literal duplicate spellings: json.dumps of a dict would erase the defect.
    cases = (
        ('"accountId": "fixture-human-owner"', 'accountId', 'account\\u0049d',
         '"fixture-machine-bot"', '"fixture-human-owner"'),
        ('"from": "990010"', 'from', 'fr\\u006fm', '"990012"', '"990010"'),
        ('"project": {"id": "990001"}', 'project', 'pro\\u006aect',
         '{"id":"990099"}', '{"id":"990001"}'),
        ('"page_size": 2', 'page_size', 'page_\\u0073ize', '1', '2'),
    )
    for target, key, escaped, left, right in cases:
        for second_key in (key, escaped):
            for first, second in ((left, right), (right, left)):
                replacement = f'"{key}":{first},"{second_key}":{second}'
                yield fixture().replace(target, replacement)
    # Unknown nested config/metadata prose must not hide duplicate keys either.
    for first, second in (('"private-left"', '"private-right"'), ('"private-right"', '"private-left"')):
        yield fixture().replace('"fields": {', '"fields": {"fixture_config":{"policy":['
                                f'{{"humans":{first},"hum\\u0061ns":{second}}}' + ']},')


class DuplicateJsonTests(unittest.TestCase):
    def assert_redacted(self, call):
        output = io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            with self.assertRaises(OfflineError) as caught:
                call()
        self.assertEqual(str(caught.exception), "fixture-json-invalid")
        self.assertEqual(caught.exception.args, ("fixture-json-invalid",))
        self.assertTrue(caught.exception.__suppress_context__)
        self.assertIsNone(caught.exception.__cause__)
        self.assertEqual(output.getvalue(), "")
        formatted = "".join(traceback.format_exception_only(caught.exception))
        self.assertNotIn("private-left", formatted)
        self.assertNotIn("fixture-human-owner", formatted)

    def test_recursive_decoded_duplicates_rejected_in_both_orders(self):
        for text in ambiguous_fixtures():
            with self.subTest(text=text):
                self.assert_redacted(lambda: literal_json(text))
        for text in ('{"private-left":1,"private-left":1}',
                     '[{"outer":[{"x":1,"\\u0078":2}]}]',
                     '{"a":{},"a":[]}', '{"":1,"":2}'):
            with self.subTest(text=text):
                self.assert_redacted(lambda: literal_json(text))

    def test_valid_objects_arrays_and_separate_object_keys_preserved(self):
        text = '{"nested":[{"x":1},{"x":2}],"other":{"x":3},"empty":{}}'
        self.assertEqual(literal_json(text), json.loads(text))

    def test_source_to_scanner_rejection_leaves_no_snapshot_or_store_progress(self):
        for text in ambiguous_fixtures():
            with self.subTest(text=text), DisposableState() as sandbox:
                store = sandbox.create(CONFIG, FENCE, CREATED)
                before_state, before_counts = store.state(), store.counts()
                with patch('evidence_watcher.simulation.classify') as classify, \
                        patch.object(store, 'apply', wraps=store.apply) as apply:
                    self.assert_redacted(lambda: OfflineScanner(
                        store, FixtureTransport(FixtureSource(text)), VirtualClock(NOW)).poll())
                    classify.assert_not_called()
                    apply.assert_not_called()
                self.assertEqual(store.state(), before_state)
                self.assertEqual(store.counts(), before_counts)
                self.assertEqual(store.inspect_outbox(), ())
                self.assertEqual(store._db.execute('SELECT count(*) FROM scan_runs').fetchone()[0], 0)

    def test_rejected_replacement_preserves_existing_source_and_completed_bounds(self):
        with DisposableState() as sandbox:
            store = sandbox.create(CONFIG, FENCE, CREATED)
            source = FixtureSource(fixture())
            transport = FixtureTransport(source)
            scanner = OfflineScanner(store, transport, VirtualClock(NOW))
            scanner.poll()
            scanner.poll()  # Establish both full and incremental completed bounds.
            state, counts, calls = store.state(), store.counts(), list(transport.calls)
            accepted_data = source._data
            for text in ambiguous_fixtures():
                self.assert_redacted(lambda: source.replace_fixture(text))
                self.assertIs(source._data, accepted_data)
                self.assertEqual(store.state(), state)
                self.assertEqual(store.counts(), counts)
                self.assertEqual(transport.calls, calls)
            scanner.poll()
            self.assertEqual(store.counts(), counts)

    def test_scripted_transport_json_uses_same_duplicate_guard(self):
        for text in ('[{"status":503,"status":200}]',
                     '[{"status":200,"sta\\u0074us":503}]',
                     '[{"status":429,"retry_after":1,"retry_after":2}]'):
            self.assert_redacted(lambda: FixtureTransport(FixtureSource(fixture()), text))

    def test_valid_human_and_machine_controls_through_full_pipeline(self):
        for actor, expected in (("fixture-human-owner", 1), ("fixture-machine-bot", 0)):
            with self.subTest(actor=actor), DisposableState() as sandbox:
                store = sandbox.create(CONFIG, FENCE, CREATED)
                text = fixture().replace('fixture-human-owner', actor)
                scanner = OfflineScanner(store, FixtureTransport(FixtureSource(text)), VirtualClock(NOW))
                scanner.poll()
                self.assertEqual(store.state()['revision'], 1)
                self.assertIsNotNone(store.state()['full_upper'])
                self.assertEqual(store.counts()['processed_events'], 1)
                self.assertEqual(store.counts()['notification_outbox'], expected)
                classification = store._db.execute('SELECT classification FROM processed_events').fetchone()[0]
                self.assertEqual(classification, 'eligible' if expected else 'actor-rejected')
