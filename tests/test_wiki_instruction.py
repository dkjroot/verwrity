"""Instructions can edit permitted wiki text, never protected human knowledge."""

from copy import deepcopy
from dataclasses import replace
import unittest
import tempfile
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

from verwrity.ai.llm import LLMRequestError
from verwrity.analysis.wiki import populate_wiki, manuscript_hash, page_hash, WikiReviewReport
from verwrity.analysis.wiki_instruction import prepare_instruction, accept_replacement
from verwrity.domain.story import StoryProject, WikiPage
from verwrity.domain.wiki_provenance import set_ai_maintenance, read_annotations, human_edit_annotations
from verwrity.project.archive import export_project, import_project
from verwrity.project.store import ProjectStore
from tests import test_wiki_ai


class WikiInstructionTest(unittest.TestCase):
    def setUp(self):
        self.project = StoryProject.demo()
        self.page = WikiPage(uuid4(), "Notes", "Human secrt.\n\nAI roug notes.")
        self.page = replace(self.page, annotations=set_ai_maintenance(self.page.body, (),
            self.page.body.index("AI"), len(self.page.body), True, str(uuid4())))
        self.project.wiki_pages = [self.page]
        self.settings = {"standard": "openai_compatible", "model": "editor-test"}
        self.context, self.prompt = prepare_instruction(self.project, self.page, "Tidy grammar.")

    def run_instruction(self, response, context=None):
        return populate_wiki(self.project, self.page, self.page.purpose, response,
            context or self.context, self.settings, instruction=True)[0]

    def response(self):
        return {"updates": [{"id": "A1", "text": "AI rough notes.", "evidence": []}],
            "suggestions": [{"quote": "Human secrt.", "replacement_text": "Human secret.",
                "explanation": "Correct spelling.", "evidence": []}]}

    def test_page_only_edit_and_suggestion_are_separate_and_roundtrip(self):
        before = deepcopy(self.project)
        updated = self.run_instruction(self.response())
        self.assertEqual(updated.body, "Human secrt.\n\nAI rough notes.")
        self.assertEqual(self.project, before)
        self.assertTrue(all(a.analysis_version == "wiki-instruct-v1" for a in updated.annotations))
        self.assertTrue(all(a.evidence == () for a in updated.annotations))
        self.assertEqual(read_annotations([a.as_dict() for a in updated.annotations], updated.body), updated.annotations)
        self.project.wiki_pages = [updated]
        self.assertEqual(import_project(export_project(self.project)[1]), self.project)
        suggestion = next(a for a in updated.annotations if a.kind == "suggestion")
        accepted = accept_replacement(updated, suggestion.id, manuscript_hash(self.project))
        self.assertEqual(accepted.body, "Human secret.\n\nAI rough notes.")
        self.assertTrue(all(a.kind == "ai_text" and a.origin == "ai_generated" for a in accepted.annotations))
        self.assertEqual(accepted.annotations[0].id, updated.annotations[0].id)
        self.project.wiki_pages = [accepted]
        self.assertEqual(import_project(export_project(self.project)[1]), self.project)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "draft.zip"
            ProjectStore(self.project, persist_path=path).commit()
            self.assertEqual(ProjectStore(persist_path=path).get(), self.project)

    def test_protection_can_be_reclaimed_without_changing_prose(self):
        updated = self.run_instruction(self.response())
        suggestion = next(a for a in updated.annotations if a.kind == "suggestion")
        accepted = accept_replacement(updated, suggestion.id, manuscript_hash(self.project))
        protected = set_ai_maintenance(accepted.body, accepted.annotations, 0, len("Human secret."), False, str(uuid4()))
        self.assertEqual(len(protected), 1)
        self.assertEqual(accepted.body[protected[0].start:protected[0].end], "AI rough notes.")

    def test_model_cannot_replace_human_by_paragraph_reference(self):
        with self.assertRaisesRegex(LLMRequestError, "outside"):
            self.run_instruction({"updates": [{"id": "P1", "text": "Hijacked"}]})

    def test_partial_human_replacement_and_ai_suggestion_rejected(self):
        updated = self.run_instruction({"suggestions": [
            {"quote": "secrt.", "replacement_text": "secret.", "explanation": "Fix"},
            {"quote": "AI roug notes.", "replacement_text": "Replaced", "explanation": "Fix"}]})
        self.assertEqual(updated.body, self.page.body)
        self.assertFalse(any(a.kind == "suggestion" for a in updated.annotations))

    def test_unverified_citations_are_omitted_without_blocking_instruction_content(self):
        scene = self.project.current_scenes()[0]
        response = {"updates": [{"id": "A1", "text": "New", "evidence": [{"scene_id": str(scene.id), "quote": scene.text}]}]}
        updated = self.run_instruction(response)
        self.assertIn("New", updated.body)
        self.assertEqual(updated.annotations[0].evidence, ())
        context, _ = prepare_instruction(self.project, self.page, "Use scene", "scene", active_scene_id=str(scene.id))
        updated = self.run_instruction(response, context)
        self.assertIn("New", updated.body)
        self.assertEqual(updated.annotations[0].evidence[0].quote, scene.text)
        response["updates"][0]["evidence"][0]["quote"] = "Fabrication"
        updated = self.run_instruction(response, context)
        self.assertIn("New", updated.body)
        self.assertEqual(updated.annotations[0].evidence, ())
        scene.historical = True
        with self.assertRaises(ValueError):
            prepare_instruction(self.project, self.page, "Use scene", "scene", active_scene_id=str(scene.id))

    def test_entirely_new_content_needs_no_quote_in_any_instruction_scope(self):
        before = deepcopy(self.project)
        for scope in ("page", "scene", "range", "manuscript"):
            with self.subTest(scope=scope):
                context, prompt = prepare_instruction(self.project, self.page, "Invent a new childhood episode.",
                    scope, 100, 100, str(self.project.current_scenes()[0].id))
                for evidence in ([], None):
                    item = {"after_id": "P1", "text": "Mara once sailed a glass boat to the moon."}
                    if evidence is not None: item["evidence"] = evidence
                    report = WikiReviewReport()
                    updated, summary, discarded = populate_wiki(self.project, self.page, self.page.purpose,
                        {"insertions": [item]}, context, self.settings, report, instruction=True)
                    self.assertIn(item["text"], updated.body)
                    self.assertTrue(updated.body.startswith("Human secrt."))
                    generated = next(a for a in updated.annotations if a.quote == item["text"])
                    self.assertEqual(generated.evidence, ())
                    self.assertEqual(generated.analysis_version, "wiki-instruct-v1")
                    self.assertEqual((report.inserted, discarded), (1, 0))
                    self.assertNotIn("supporting quote", summary)
                self.assertIn("never a requirement for new creative content", prompt)
        self.assertEqual(self.project, before)

    def test_mixed_citations_keep_only_verified_evidence_and_report_omissions(self):
        scene = self.project.current_scenes()[0]
        context, _ = prepare_instruction(self.project, self.page, "Invent more detail.", "scene", active_scene_id=str(scene.id))
        evidence = [{"scene_id": str(scene.id), "quote": scene.text},
            {"quote": "Invented supporting quotation."}, {"source_type": "wiki", "quote": self.page.body}]
        report = WikiReviewReport()
        updated, summary, discarded = populate_wiki(self.project, self.page, self.page.purpose,
            {"updates": [{"id": "A1", "text": "Creative new detail.", "evidence": evidence}]},
            context, self.settings, report, instruction=True)
        self.assertEqual(len(updated.annotations[0].evidence), 1)
        self.assertEqual(updated.annotations[0].evidence[0].quote, scene.text)
        self.assertEqual((report.updated, report.omitted_citations, discarded), (1, 2, 0))
        self.assertIn("2 unverified manuscript citations were omitted", summary)
        self.assertNotIn("Proposed changes were skipped", summary)
        self.project.wiki_pages = [updated]
        self.assertEqual(import_project(export_project(self.project)[1]), self.project)

    def test_malformed_optional_citations_do_not_block_creative_operations(self):
        for raw in (None, "No supporting quotation", [{}] * 9, [{}]):
            with self.subTest(raw=raw):
                updated = self.run_instruction({"updates": [{"id": "A1", "text": "Creative text.", "evidence": raw}]})
                self.assertIn("Creative text.", updated.body)
                self.assertEqual(updated.annotations[0].evidence, ())

    def test_instruction_rejections_refer_to_instruction_action(self):
        report = WikiReviewReport()
        _, summary, discarded = populate_wiki(self.project, self.page, self.page.purpose,
            {"insertions": [{"after_id": "P99", "text": "Creative text."}]},
            self.context, self.settings, report, instruction=True)
        self.assertEqual(discarded, 1)
        self.assertIn("Run instruction", summary)
        self.assertNotIn("Update from manuscript", summary)

    def test_populate_mode_still_requires_evidence(self):
        updated = populate_wiki(self.project, self.page, "Notes", self.response(), self.context, self.settings)[0]
        self.assertEqual(updated.body, self.page.body)
        self.assertFalse(any(a.kind == "suggestion" for a in updated.annotations))

    def test_scopes_bounds_and_oversize(self):
        scenes = self.project.current_scenes()
        current = str(scenes[1].id)
        context, _ = prepare_instruction(self.project, self.page, "Do it", "scene", active_scene_id=current)
        self.assertEqual(context["scene_ids"], {current})
        context, _ = prepare_instruction(self.project, self.page, "Do it", "range", 100, 0, current)
        self.assertEqual(context["scene_ids"], {str(s.id) for s in scenes[:2]})
        context, _ = prepare_instruction(self.project, self.page, "Do it", "manuscript")
        self.assertEqual(context["scene_ids"], {str(s.id) for s in scenes})
        self.assertEqual(context["wiki_ids"], set())
        self.assertNotIn(scenes[0].text, self.prompt)
        for kwargs in ({"scope": []}, {"before": True}, {"after": 101}, {"instruction": ""}):
            with self.subTest(kwargs=kwargs), self.assertRaises(ValueError):
                prepare_instruction(self.project, self.page, **{"instruction": "Do it", **kwargs})
        scenes[0].text = "x" * 1_000_001
        with self.assertRaisesRegex(ValueError, "No partial"):
            prepare_instruction(self.project, self.page, "Do it", "manuscript")

    def test_stale_dismissed_and_adopted_suggestions_cannot_apply(self):
        updated = self.run_instruction(self.response())
        suggestion = next(a for a in updated.annotations if a.kind == "suggestion")
        for page, source in [(updated, "stale"), (replace(updated, annotations=tuple(
            replace(a, status="dismissed") if a.id == suggestion.id else a for a in updated.annotations)), suggestion.source_hash),
            (replace(updated, annotations=human_edit_annotations(updated.body, updated.body + "Human edits", updated.annotations)), suggestion.source_hash)]:
            with self.assertRaises(ValueError):
                accept_replacement(page, suggestion.id, source)

    def test_legacy_annotations_cannot_drop_required_evidence(self):
        updated = self.run_instruction(self.response())
        data = updated.annotations[0].as_dict(); data["analysis_version"] = "wiki-v2"
        with self.assertRaises(ValueError): read_annotations([data], updated.body)


class WikiInstructionRoutesTest(unittest.TestCase):
    setUp = test_wiki_ai.WikiAIRoutesTest.setUp
    apply = test_wiki_ai.WikiAIRoutesTest.apply

    def generate(self, **options):
        return self.client.post(f"/ai/wiki/{self.page.id}", json={"action": "instruct", "instruction": "Tidy grammar.",
            "page_hash": page_hash(self.page), **options})

    def test_human_suggestion_requires_acceptance_and_is_recoverable(self):
        self.response = {"suggestions": [{"quote": "Human secret.", "replacement_text": "A human secret.", "explanation": "Add article."}]}
        result = self.generate(); self.assertEqual(result.status_code, 200, result.json)
        self.assertEqual(self.store.get().wiki_pages[0], self.page)
        updated = self.apply(result); self.assertEqual(updated.status_code, 200)
        page = self.store.get().wiki_pages[0]; self.assertEqual(page.body, self.page.body)
        a = page.annotations[0]
        url = f"/wiki/page/{page.id}/suggestion/{a.id}/accept"
        before = deepcopy(self.store.get())
        with patch.object(self.store, "commit", side_effect=OSError("disk full")):
            self.assertEqual(self.client.post(url, json={"page_hash": page_hash(page)}).status_code, 503)
        self.assertEqual(self.store.get(), before)
        accepted = self.client.post(url, json={"page_hash": page_hash(page)})
        self.assertEqual(accepted.status_code, 200, accepted.json)
        page = self.store.get().wiki_pages[0]
        self.assertEqual(page.body, "A human secret.")
        self.assertEqual(page.annotations[0].origin, "ai_generated")
        self.assertEqual(page.revisions[-1].body, "Human secret.")
        self.assertEqual(self.scene.text, before.scenes[0].text)
        self.assertEqual(import_project(export_project(self.store.get())[1]), self.store.get())
        self.assertEqual(self.client.post(url, json={"page_hash": page_hash(page)}).status_code, 400)

    def test_invalid_context_and_consent_make_no_provider_call(self):
        for options in ({"instruction": ""}, {"scope": []}, {"after_percent": True}, {"before_percent": 101}):
            self.assertEqual(self.generate(**options).status_code, 400)
        with patch.object(self.app.extensions["ai_settings"], "load", return_value={"llm": {
                "endpoint": "https://example.test/v1", "remote_consent_endpoint": ""}}):
            self.assertEqual(self.generate().status_code, 403)
        self.assertEqual(self.calls, [])

    def test_stale_proposals_and_acceptance_rejected(self):
        self.response = {"suggestions": [{"quote": "Human secret.", "replacement_text": "New secret.", "explanation": "Edit"}]}
        result = self.generate(); self.scene.text += " Changed"
        self.assertEqual(self.apply(result).status_code, 409)
        self.apply(self.generate()); page = self.store.get().wiki_pages[0]; a = page.annotations[0]
        url = f"/wiki/page/{page.id}/suggestion/{a.id}/accept"
        self.assertEqual(self.client.post(url, json={"page_hash": "stale"}).status_code, 409)
        self.scene.text += " Changed again"
        self.assertEqual(self.client.post(url, json={"page_hash": page_hash(page)}).status_code, 400)

    def test_snapshot_save_returns_json_and_preserves_authorship(self):
        response = self.client.post(f"/wiki/page/{self.page.id}/save?response=json", data={
            "title": self.page.title, "body": "Edited secret.", "page_hash": page_hash(self.page),
            "authorship_edits": '[{"start":0,"end":13,"text":"Edited secret."}]'}, headers={"Accept": "application/json"})
        self.assertEqual(response.status_code, 200, response.json)
        self.assertEqual(response.json["body"], "Edited secret.")
        self.assertEqual(response.json["annotations"], [])

    def test_instruction_preserves_author_purpose_exactly(self):
        self.page = replace(self.page, purpose="  Keep this author intent.  ")
        self.store.get().wiki_pages[0] = self.page
        self.response = {}
        result = self.generate(); self.assertEqual(result.status_code, 200)
        self.assertEqual(self.apply(result).json["purpose"], self.page.purpose)

    def test_creative_proposal_omits_invalid_citation_and_preserves_human_text(self):
        self.response = {"insertions": [{"after_id": "P1", "text": "A wholly invented backstory.",
            "evidence": [{"quote": "There is no such manuscript quotation."}]}],
            "suggestions": [{"quote": "Human secret.", "replacement_text": "Creative human replacement.",
                "explanation": "Provisional creative suggestion.", "evidence": [{"source_type": "wiki", "quote": "Human secret."}]}]}
        result = self.generate(instruction="Invent a backstory.", scope="manuscript")
        self.assertEqual(result.status_code, 200, result.json)
        self.assertEqual((result.json["applied"], result.json["omitted_citations"], result.json["rejections"]), (2, 2, []))
        self.assertFalse(result.json["correction_attempted"])
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.store.get().wiki_pages[0], self.page)
        updated = self.apply(result); self.assertEqual(updated.status_code, 200)
        self.assertEqual(updated.json["body"], "Human secret.\n\nA wholly invented backstory.")
        self.assertTrue(all(not a["evidence"] for a in updated.json["annotations"]))
        self.assertEqual(updated.json["annotations"][0]["origin"], "ai_generated")


if __name__ == "__main__":
    unittest.main()
