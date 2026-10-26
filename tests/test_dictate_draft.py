"""Draft cleanup is view-only and preserves exact speech and private boundaries."""
from copy import deepcopy
from io import BytesIO
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from verwrity.ai.dictate_draft import (cleanup_prompt, configuration_hash, review_cleanup, validate_cleanup,
    vocabulary_prompt, validate_vocabulary)
from verwrity.ai.settings import UserAISettings
from verwrity.domain.story import StoryProject, WikiPage
from verwrity.project.library import ProjectLibrary
from verwrity.project.store import ProjectStore
from verwrity.web.app import create_app
from uuid import uuid4


class CleanupTest(unittest.TestCase):
    def edits(self, text, edits, terms=()):
        return validate_cleanup(text, list(terms), json.dumps({"edits": edits}))

    def test_exact_unicode_offsets_and_categories(self):
        text = "😀 i met elrin\nthen left"
        changes = [dict(start=2, end=3, before="i", after="I", category="capitalisation"),
            dict(start=8, end=13, before="elrin", after="Elryn", category="vocabulary"),
            dict(start=13, end=14, before="\n", after=".\n\n", category="punctuation")]
        result = self.edits(text, changes, ["Elryn"])
        self.assertEqual(result["text"], "😀 I met Elryn.\n\nthen left")
        self.assertEqual(result["edits"][:2], changes[:2])
        self.assertEqual(result["edits"][2], dict(start=13, end=13, before="", after=".\n", category="punctuation"))
        self.assertEqual(text, "😀 i met elrin\nthen left")

    def test_voice_transcription_prompt_and_reviewable_mishearing_repair(self):
        prompt = cleanup_prompt("I herd him", "", [])
        self.assertIn("VOICE TRANSCRIPTION", prompt)
        self.assertIn("most plausible interpretation", prompt)
        self.assertIn("missing opening", prompt)
        self.assertIn("Dialogue may span paragraphs", prompt)
        self.assertIn("Do not count characters", prompt)
        self.assertNotIn('"start":', prompt)
        self.assertNotIn('"category":', prompt)
        result = self.edits("I herd him", [dict(start=2, end=6, before="herd", after="heard", category="transcription")])
        self.assertEqual(result["text"], "I heard him")
        self.assertEqual(result["edits"][0]["category"], "transcription")

    def test_missing_opening_dialogue_quote_is_a_valid_review_edit(self):
        source = 'Come back," she said.'
        result = self.edits(source, [dict(start=0, end=0, before="", after='"', category="punctuation")])
        self.assertEqual(result["text"], '"Come back," she said.')

    def test_quote_edits_need_no_model_counting_and_resolve_unicode_and_context(self):
        text = "😀 I herd her. Later, I herd him."
        result = self.edits(text, [dict(before="herd", after="heard", category="transcription", context="I herd him.")])
        self.assertEqual(result["text"], "😀 I herd her. Later, I heard him.")
        self.assertEqual(result["edits"][0]["start"], text.rindex("herd"))
        result = self.edits("😀 Come back, she said.", [dict(before="Come back", after='"Come back', category="punctuation")])
        self.assertEqual(result["edits"], [dict(start=2, end=2, before="", after='"', category="punctuation")])
        for change in [dict(before="herd", after="heard", category="transcription"),
                dict(before="herd", after="heard", category="transcription", context="I herd"),
                dict(before="herd", after="heard", category="transcription", context="Absent quote"),
                dict(before="", after='"', category="punctuation")]:
            with self.subTest(change=change), self.assertRaises(ValueError): self.edits(text, [change])

    def test_unique_whole_word_match_ignores_occurrences_inside_other_words(self):
        result = self.edits("i waited by the stair", [dict(before="i", after="I")])
        self.assertEqual(result["text"], "I waited by the stair")
        with self.assertRaises(ValueError):
            self.edits("i waited and i listened", [dict(before="i", after="I")])

    def test_miscounted_offsets_use_only_unambiguous_exact_raw_evidence(self):
        source = "😀 The blue path led Towards the station."
        result = self.edits(source, [dict(start=8, end=15, before="Towards", after="towards", category="capitalisation")])
        offset = source.index("Towards")
        self.assertEqual(result["text"], source.replace("Towards", "towards"))
        self.assertEqual(result["edits"][0]["start"], offset)
        self.assertEqual(result["edits"][0]["end"], offset + 1)
        # Retain an exact given start when only the end was miscounted. An
        # unchanged letter may anchor an insertion even if it occurs elsewhere.
        source = "How may I help? Her voice was calm."
        result = self.edits(source, [dict(start=0, end=0, before="H", after='"H', category="punctuation")])
        self.assertEqual(result["text"], '"' + source)
        self.assertEqual(result["edits"], [dict(start=0, end=0, before="", after='"', category="punctuation")])
        for text, changes in [
            ("Towards town, Towards home", [dict(start=2, end=9, before="Towards", after="towards", category="capitalisation")]),
            ("aaab", [dict(start=2, end=4, before="aa", after="aA", category="capitalisation")]),
            ("A silent room.", [dict(start=0, end=3, before="Towards", after="towards", category="capitalisation")]),
            ("She hurried roughly away.", [dict(start=1, end=8, before="roughly away", after="rolling away", category="transcription")]),
            ("a b", [dict(start=0, end=0, before="", after="A", category="punctuation")]),
        ]:
            with self.subTest(text=text), self.assertRaises(ValueError): self.edits(text, changes)

    def test_explicit_no_change_reports_succeed_with_exact_raw_text(self):
        text = "It’s clean 😀 & <literal>.\n\nNext paragraph."
        for response in ['{"edits":[]}', '```json\n{"edits":[]}\n```', '```json\r\n{"edits":[]}\r\n```',
                '{"edits":null}', '{"status":"clean"}', '{"clean":true}',
                '{"changes":[]}', '{"suggestions":null}', '{"needs_cleanup":false}',
                "CLEAN", "The text is clean.", "**No changes needed.**", '"clean"', "```\nCLEAN\n```"]:
            with self.subTest(response=response):
                result = validate_cleanup(text, [], response)
                self.assertEqual(result["text"], text)
                self.assertEqual(result["edits"], [])
        for response in ['{"status":"clean","text":"Rewritten"}', '{"edits":[],"text":"Rewritten"}',
                '{"clean":true,"changes":["delete speech"]}', '{"clean":true,"error":"failed"}',
                'The text is clean, but I rewrote it below.', '{}', 'null', '{"status":["clean"]}']:
            with self.subTest(response=response), self.assertRaises(ValueError):
                validate_cleanup(text, [], response)

    def test_rewrites_omissions_facts_and_fabricated_terms_are_rejected(self):
        for category, before, after, terms in [
            ("punctuation", "she left", "she died", []),
            ("capitalisation", "he said said", "he said", []),
            ("vocabulary", "town", "Paris", []),
            ("vocabulary", "he", "Elryn", ["Elryn"]),
            ("paragraphing", "word", "", []),
            ("rewrite", "I said", "I explained", []),
            ("transcription", "he said said", "he said", []),
            ("transcription", "she left", "she died", []),
            ("transcription", "I have 3", "I have 9", []),
        ]:
            with self.subTest(category=category, before=before), self.assertRaises(ValueError):
                self.edits(before, [dict(start=0, end=len(before), before=before, after=after, category=category)], terms)
        for text, start, end, after in [("two words", 3, 4, ""), ("don't", 3, 4, ""), ("someone", 4, 4, " ")]:
            with self.assertRaises(ValueError):
                self.edits(text, [dict(start=start, end=end, before=text[start:end], after=after, category="punctuation")])

    def test_json_inside_markdown_or_explanations_keeps_all_edit_checks(self):
        change = json.dumps({"edits": [dict(before="i", after="I", category="capitalisation")]})
        for wrapped in [f"Here is your JSON:\n{change}\nDone.",
                f"Here you go:\n```json\n{change}\n```\nHope that helps.",
                f"```JSON\r\n{change}\r\n```", f"Unrelated {{\"example\":1}}. Answer: {change}"]:
            with self.subTest(wrapped=wrapped):
                self.assertEqual(validate_cleanup("i left", [], wrapped)["text"], "I left")
        self.assertEqual(validate_cleanup("Raw text.", [], 'Here you go: ```JSON\n{"edits":[]}\n```')["text"], "Raw text.")
        for wrapped in [change + '\nAnother answer: {"edits":[]}',
                'Here is an array with the wrong contract: [' + change + ']',
                change + ('{' * 101) + '{"edits":[]}',
                'Here you go: {"edits":[{"before":"i left","after":"she died","category":"punctuation"}]}',
                'Here is an example: {"example":{"edits":[]}}',
                '```json\n{"edits":[]\n```']:
            with self.subTest(wrapped=wrapped), self.assertRaises(ValueError):
                validate_cleanup("i left", [], wrapped)

    def test_stale_or_invalid_offsets_rejected(self):
        edit = dict(start=0, end=1, before="i", after="I", category="capitalisation")
        for edits in [[{**edit, "start": True}], [{**edit, "before": "x"}], [{**edit, "end": 100}]]:
            with self.assertRaises(ValueError): self.edits("i", edits)

    def test_dialogue_quotes_at_multiple_positions_and_mixed_case_need_no_category(self):
        cases = [
            ("Here is the gate he said after a while Right over there", [
                dict(before="Here is the gate he said", after='"Here is the gate," he said', category="punctuation"),
                dict(before="after a while Right over", after="after a while. Right over")],
                '"Here is the gate," he said after a while. Right over there'),
            ("A bell rang. Oh, said the girl.", [
                dict(before="Oh, said the girl", after='"Oh," said the girl', category="punctuation")],
                'A bell rang. "Oh," said the girl.'),
            ("waiting by the gate, listening. Let's leave.", [
                dict(before="waiting by the gate", after="Waiting, by the gate,", category="punctuation"),
                dict(before="gate, listening", after="gate, listening", category="punctuation"),
                dict(before="Let's leave.", after='"Let\'s leave."')],
                'Waiting, by the gate,, listening. "Let\'s leave."'),
        ]
        # Retain exactly what the model proposed for review, including an extra
        # comma. Validation verifies source/word preservation, not literary taste.
        for source, suggestions, expected in cases:
            with self.subTest(source=source):
                response = 'Here you go:\n```JSON\n' + json.dumps(dict(edits=suggestions)) + '\n```'
                result = review_cleanup(source, [], response)
                self.assertEqual(result["text"], expected)
                self.assertNotIn("skipped_edits", result)
                reconstructed = source
                for edit in reversed(result["edits"]):
                    self.assertEqual(source[edit["start"]:edit["end"]], edit["before"])
                    reconstructed = reconstructed[:edit["start"]] + edit["after"] + reconstructed[edit["end"]:]
                self.assertEqual(reconstructed, expected)

    def test_categories_are_not_required_or_trusted_and_lexical_anchors_are_accepted(self):
        for category in [None, "punctuation", "unrecognised", ["capitalisation"]]:
            suggestions = [dict(before="i herd him", after='"I heard him."', category=category)]
            result = self.edits("😀 i herd him", suggestions)
            self.assertEqual(result["text"], '😀 "I heard him."')
            self.assertEqual([edit["category"] for edit in result["edits"]],
                ["punctuation", "capitalisation", "transcription", "punctuation"])
        long_quote = "word " * 70 + "end"
        self.assertEqual(self.edits(long_quote, [dict(before=long_quote, after='"' + long_quote + '"')])["text"],
            '"' + long_quote + '"')

    def test_valid_suggestions_survive_bad_siblings_without_retry(self):
        source = "i waited. Go now, she said."
        suggestions = [dict(before="missing", after="Missing"), None,
            dict(before="i waited", after="She departed forever"),
            dict(before="Go now, she said", after='"Go now," she said'),
            dict(before="i", after="I"), dict(before="waited", after="waited")]
        result = review_cleanup(source, [], json.dumps(dict(edits=suggestions)))
        self.assertEqual(result["text"], 'I waited. "Go now," she said.')
        self.assertEqual(result["skipped_edits"], 3)
        self.assertNotIn("outcome", result)

    def test_sorting_duplicates_and_overlapping_anchors_preserve_unique_actual_changes(self):
        suggestions = [dict(before="he said", after="he said."),
            dict(before="Wait he said", after='"Wait," he said'),
            dict(before="Wait he said", after='"Wait," he said')]
        result = self.edits("Wait he said", suggestions)
        self.assertEqual(result["text"], '"Wait," he said.')
        self.assertEqual(len(result["edits"]), 3)

    def test_conflicting_suggestions_are_withheld_together_and_unrelated_edits_survive(self):
        source = "i waited. Come back, she said."
        suggestions = [dict(before="i", after="I"),
            dict(before="Come back, she said", after='"Come back," she said'),
            dict(before="Come back", after="‘Come back")]
        result = review_cleanup(source, [], json.dumps(dict(edits=suggestions)))
        self.assertEqual(result["text"], "I waited. Come back, she said.")
        self.assertEqual(result["skipped_edits"], 2)

    def test_category_free_repairs_still_reject_word_loss_numbers_and_ambiguous_quotes(self):
        for source, change in [
            ("said said", dict(before="said", after="Said")),
            ("he said said", dict(before="he said said", after="He said.")),
            ("she left", dict(before="she left", after="she died")),
            ("3 apples", dict(before="3 apples", after="9 apples")),
            ("don't", dict(before="don't", after="dont")),
            ("two words", dict(before=" ", after="")),
            ("someone", dict(start=4, end=4, before="", after=" ")),
        ]:
            with self.subTest(source=source):
                result = review_cleanup(source, [], json.dumps(dict(edits=[change])))
                self.assertEqual(result["text"], source)
                self.assertEqual(result["outcome"], "no_notes")

    def test_empty_speech_and_scope_limits(self):
        for text, previous, terms in [("", "", []), ("a" * 20001, "", []), ("speech", "x" * 2001, []), ("speech", "", ["x"] * 1501)]:
            with self.assertRaises(ValueError): cleanup_prompt(text, previous, terms)
        prompt = cleanup_prompt("raw", "neighbour", ["Elryn"])
        self.assertNotIn("neighbour", prompt)
        self.assertNotIn("previous_context", prompt)
        self.assertNotIn("manuscript", prompt)

    def test_vocabulary_requires_unique_exact_current_source_evidence(self):
        sources = {"scene": "Elryn walked into Ilmar."}
        values = [dict(term="Elryn", quote="Elryn walked", scene_id="scene"),
            dict(term="Invented", quote="Elryn walked", scene_id="scene"),
            dict(term="Ilmar", quote="Ilmar", scene_id="historical"),
            dict(term="Elryn", quote="Elryn walked", scene_id="scene")]
        result = validate_vocabulary('Here are the terms:\n```JSON\n' + json.dumps({"terms": values}) + '\n```', sources)
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["start"], 0)
        self.assertEqual(validate_vocabulary(json.dumps({"terms": [values[0]]}), {"scene": "Elryn walked Elryn walked"}), [])
        project = StoryProject.demo(); project.scenes[0].text = "x" * 300001
        with self.assertRaises(ValueError): vocabulary_prompt(project)


class DraftRoutesTest(unittest.TestCase):
    def setUp(self):
        temp = TemporaryDirectory(); self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        project = StoryProject.demo()
        project.scenes[0].text = "Elryn waited."
        project.spelling_dictionary.add("Ilmar")
        project.wiki_pages = [WikiPage(uuid4(), "Elryn", "Private wiki body", aliases=("Eryn",))]
        self.app = create_app(ProjectStore(project))
        self.app.config["PROJECT_DRAFT_ROOT"] = self.root / "drafts"
        self.app.config["PROJECT_LIBRARY"] = ProjectLibrary(self.root)
        self.settings = UserAISettings(self.root)
        self.app.extensions["ai_settings"] = self.settings
        self.settings.update_llm("local-user", {"standard": "openai_compatible", "endpoint": "localhost:8080", "model": "test"}, self.app.extensions["llm_registry"])
        self.client = self.app.test_client()
        self.context = self.client.get("/ai/dictate-draft").json
        self.llm = self.app.extensions["llm_registry"].get("openai_compatible")

    def payload(self, **kwargs):
        return dict(project_id=self.context["project_id"], configuration=self.context["configurations"]["llm"],
            text="i left", previous="", terms=["Elryn"], **kwargs)

    def test_context_has_names_and_dictionary_but_no_wiki_body_or_credentials(self):
        self.assertEqual(set(self.context["terms"]), {"Elryn", "Eryn", "Ilmar"})
        self.assertNotIn("Private wiki body", json.dumps(self.context))
        self.assertEqual(self.context["settings"]["llm"]["token"], "")

    def test_cleanup_does_not_save_or_send_manuscript_or_wiki(self):
        store = next(iter(self.app.config["PROJECT_STORES"].values()))
        before = deepcopy(store.get())
        with patch.object(type(self.llm), "complete", return_value='{"edits":[{"before":"i","after":"I","category":"capitalisation"}]}') as call:
            result = self.client.post("/ai/dictate-draft/cleanup", json=self.payload())
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json["text"], "I left")
        self.assertEqual(result.json["edits"], [dict(start=0, end=1, before="i", after="I", category="capitalisation")])
        self.assertNotIn("Elryn waited", call.call_args.args[3])
        self.assertNotIn("Private wiki body", call.call_args.args[3])
        self.assertEqual(store.get(), before)
        self.assertEqual(result.headers["Cache-Control"], "no-store")

    def test_fenced_empty_edits_succeed_through_http_client_and_review_route(self):
        store = next(iter(self.app.config["PROJECT_STORES"].values()))
        before = deepcopy(store.get())
        response = BytesIO(json.dumps({"choices": [{"message": {
            "content": 'Here you go:\n```JSON\n{"edits":[]}\n```'}}]}).encode("utf-8"))
        with patch("verwrity.ai.llm.build_opener") as opener:
            opener.return_value.open.return_value = response
            result = self.client.post("/ai/dictate-draft/cleanup", json=self.payload())
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json["text"], "i left")
        self.assertEqual(result.json["edits"], [])
        opener.return_value.open.assert_called_once()
        self.assertEqual(store.get(), before)

    def test_http_model_response_keeps_dialogue_and_case_with_invalid_sibling(self):
        store = next(iter(self.app.config["PROJECT_STORES"].values()))
        before = deepcopy(store.get())
        data = self.payload()
        data["text"] = "there is the gate he said. We should go."
        model_response = '```json\n' + json.dumps({"edits": [
            dict(before="there is the gate he said", after='"There is the gate," he said', category="punctuation"),
            dict(before="not in this section", after="Gone"),
            dict(before="We should go.", after='"We should go."'),
            dict(before="he said", after="he said"),
        ]}) + '\n```'
        response = BytesIO(json.dumps({"choices": [{"message": {"content": model_response}}]}).encode("utf-8"))
        with patch("verwrity.ai.llm.build_opener") as opener:
            opener.return_value.open.return_value = response
            result = self.client.post("/ai/dictate-draft/cleanup", json=data)
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json["text"], '"There is the gate," he said. "We should go."')
        self.assertEqual(result.json["skipped_edits"], 1)
        self.assertEqual(len(result.json["edits"]), 5)
        opener.return_value.open.assert_called_once()
        self.assertEqual(store.get(), before)

    def test_edit_of_previous_context_is_rejected_without_an_automatic_retry(self):
        data = self.payload()
        data["previous"] = "Earlier context mentioned the Genome Genomics Building."
        data["text"] = "The current speaker waits for an answer. " * 5
        response = '```json\n{"edits":[{"start":103,"end":110,"before":"Genome","after":"genomic","category":"transcription"}]}\n```'
        with patch.object(type(self.llm), "complete", return_value=response) as call:
            result = self.client.post("/ai/dictate-draft/cleanup", json=data)
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json["text"], data["text"])
        self.assertEqual(result.json["edits"], [])
        self.assertEqual(result.json["outcome"], "no_notes")
        call.assert_called_once()
        self.assertNotIn("Genome", data["text"])
        self.assertNotIn(data["previous"], call.call_args.args[3])

    def test_cleanup_calls_contain_only_their_own_section_even_with_legacy_context(self):
        context = "An earlier section with deliberately different words."
        sections = ["We walked Towards the gate.", "I herd a bell by the gate."]
        replies = ['```json\n{"edits":[{"before":"Towards","after":"towards","category":"capitalisation"}]}\n```',
            'Here is your JSON:\n{"edits":[{"before":"herd","after":"heard","category":"transcription"}]}']
        with patch.object(type(self.llm), "complete", side_effect=replies) as call:
            results = []
            for section in sections:
                data = self.payload(); data.update(text=section, previous=context)
                results.append(self.client.post("/ai/dictate-draft/cleanup", json=data))
        self.assertEqual([result.status_code for result in results], [200, 200])
        self.assertEqual([result.json["text"] for result in results], ["We walked towards the gate.", "I heard a bell by the gate."])
        for index, invocation in enumerate(call.call_args_list):
            prompt = invocation.args[3]
            sent = json.loads(prompt.split("Input data:\n", 1)[1])
            self.assertEqual(set(sent), {"raw", "approved_vocabulary"})
            self.assertEqual(sent["raw"], sections[index])
            self.assertNotIn(context, prompt)
            self.assertNotIn(sections[1 - index], prompt)

    def test_unusable_model_answers_complete_as_no_notes_without_retry(self):
        store = next(iter(self.app.config["PROJECT_STORES"].values()))
        before = deepcopy(store.get())
        for response in ['not JSON', '{}', 'null', '{"edits":[{"before":"missing"}]}',
                '{"edits":[{"before":"i left","after":"she died","category":"transcription"}]}']:
            with self.subTest(response=response), patch.object(type(self.llm), "complete", return_value=response) as call:
                result = self.client.post("/ai/dictate-draft/cleanup", json=self.payload())
                self.assertEqual(result.status_code, 200)
                self.assertEqual(result.json["text"], "i left")
                self.assertEqual(result.json["edits"], [])
                self.assertEqual(result.json["outcome"], "no_notes")
                call.assert_called_once()
        self.assertEqual(store.get(), before)
        with patch.object(type(self.llm), "complete") as call:
            data = self.payload(); data["text"] = ""
            self.assertEqual(self.client.post("/ai/dictate-draft/cleanup", json=data).status_code, 400)
            call.assert_not_called()

    def test_config_project_and_consent_are_checked_before_calls(self):
        for key, value, expected in [("configuration", "stale", 409), ("project_id", str(uuid4()), 409)]:
            data = self.payload(); data[key] = value
            with patch.object(type(self.llm), "complete") as call:
                self.assertEqual(self.client.post("/ai/dictate-draft/cleanup", json=data).status_code, expected)
            call.assert_not_called()
        self.settings.update_llm("local-user", {"endpoint": "https://review.example/v1", "model": "test", "remote_consent": True}, self.app.extensions["llm_registry"])
        self.context = self.client.get("/ai/dictate-draft").json
        with patch.object(type(self.llm), "complete", return_value='{"edits":[]}') as call:
            self.assertEqual(self.client.post("/ai/dictate-draft/cleanup", json=self.payload()).status_code, 403)
            call.assert_not_called()
            self.assertEqual(self.client.post("/ai/dictate-draft/cleanup", json=self.payload(consent_endpoint="https://review.example/v1")).status_code, 200)

    def test_vocabulary_saved_snapshot_and_private_failure(self):
        data = self.payload(source_hash="stale")
        with patch.object(type(self.llm), "complete") as call:
            self.assertEqual(self.client.post("/ai/dictate-draft/vocabulary", json=data).status_code, 409)
            call.assert_not_called()
        data["source_hash"] = self.context["source_hash"]
        scene_id = str(self.app.config["INITIAL_PROJECT"].scenes[0].id)
        with patch.object(type(self.llm), "complete", return_value=json.dumps({"terms": [dict(term="Elryn", quote="Elryn waited.", scene_id=scene_id)]})):
            result = self.client.post("/ai/dictate-draft/vocabulary", json=data)
        self.assertEqual(result.json["terms"][0]["term"], "Elryn")
        with patch.object(type(self.llm), "complete", side_effect=RuntimeError("private words secret")):
            with self.assertLogs(self.app.logger, level="WARNING") as logs:
                result = self.client.post("/ai/dictate-draft/cleanup", json=self.payload())
        self.assertEqual(result.status_code, 502)
        self.assertNotIn("private words", result.text + str(logs.output))

    def test_bound_stt_reuses_audio_only_provider_and_rejects_changed_settings(self):
        provider = self.app.extensions["stt_registry"].get("faster_whisper")
        with patch.object(provider, "transcribe", return_value="raw") as call:
            response = self.client.post("/ai/transcribe", data=b"RIFF", content_type="audio/wav", headers={"X-Verwrity-STT-Configuration": "stale"})
            self.assertEqual(response.status_code, 409); call.assert_not_called()
            response = self.client.post("/ai/transcribe", data=b"RIFF", content_type="audio/wav", headers={"X-Verwrity-STT-Configuration": self.context["configurations"]["stt"]})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(call.call_args.args[0].data, b"RIFF")
            self.assertNotIn("terms", call.call_args.args[1])
