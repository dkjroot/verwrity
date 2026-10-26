"""Model response variability must not relax authorship or invent success."""
from dataclasses import replace
import json
import unittest
from unittest.mock import patch
from uuid import uuid4

from verwrity.analysis.wiki import prepare_wiki, populate_wiki, WikiReviewReport, repair_wiki_prompt, page_hash
from verwrity.ai.llm import LLMRequestError
from verwrity.domain.story import StoryProject, WikiPage
from verwrity.domain.wiki_provenance import set_ai_maintenance


class WikiResponseTest(unittest.TestCase):
    def setUp(self):
        self.project = StoryProject.demo()
        self.project.scenes[0].text = "Mara has blue eyes. She lives beside the river."
        self.project.scenes[1].text = "Mara remembers June."
        body = "Protected author secret.\n\nHuman draft.\n\nHuman draft."
        self.page = WikiPage(uuid4(), "Mara", body,
            annotations=set_ai_maintenance(body, (), body.index("Human"), len(body), True, str(uuid4())))
        self.settings = {"standard": "openai_compatible", "model": "test"}
        self.context, self.prompt = prepare_wiki(self.project, self.page, "Biography")

    def apply(self, response, context=None):
        self.report = WikiReviewReport()
        return populate_wiki(self.project, self.page, "Biography", response, context or self.context,
            self.settings, self.report)

    def test_delegated_refresh_uses_short_reference_and_exact_quote_without_copied_uuid(self):
        updated, summary, count = self.apply({"summary": "Populated everything!", "updates": [
            {"id": "A2", "text": "Mara lives by the river.", "evidence": [{"quote": "She lives beside the river."}]}]})
        self.assertEqual(updated.body, self.page.body.rsplit("Human draft.", 1)[0] + "Mara lives by the river.")
        generated = next(a for a in updated.annotations if a.origin == "ai_generated")
        self.assertEqual(generated.evidence[0].scene_id, self.project.scenes[0].id)
        self.assertEqual((self.report.updated, count), (1, 0))
        self.assertIn("1 updated", summary)
        self.assertNotIn("Populated everything", summary)
        self.assertEqual(updated.annotations[-1].id, self.page.annotations[0].id)

    def test_after_id_handles_repeated_page_quotations_without_inserting_inside_ai_text(self):
        updated, _, count = self.apply({"insertions": [{"after_id": "A1", "text": "\n\nBlue eyes.",
            "evidence": [{"quote": "Mara has blue eyes."}]}]})
        self.assertEqual(updated.body, "Protected author secret.\n\nHuman draft.\n\nBlue eyes.\n\nHuman draft.")
        self.assertEqual(count, 0)

    def test_additions_anywhere_on_protected_page_preserve_existing_words_and_own_only_new_blocks(self):
        self.page = replace(self.page, body="😀 Human paragraph.\n\nHuman paragraph.", annotations=())
        self.context, prompt = prepare_wiki(self.project, self.page, "Biography")
        self.assertIn('"ref": "P2"', prompt)
        self.assertIn("even when the whole page is human-written", prompt)
        evidence = [{"quote": "Mara has blue eyes."}]
        updated, _, count = self.apply({"insertions": [
            {"before_id": "P1", "text": "First AI detail.", "evidence": evidence},
            {"after_id": "P1", "text": "Middle AI detail.", "evidence": evidence},
            {"after_id": "P2", "text": "Last AI detail.", "evidence": evidence}]})
        self.assertEqual(updated.body, "First AI detail.\n\n😀 Human paragraph.\n\nMiddle AI detail.\n\nHuman paragraph.\n\nLast AI detail.")
        self.assertEqual(count, 0)
        self.assertEqual(self.report.inserted, 3)
        self.assertEqual({a.quote for a in updated.annotations}, {"First AI detail.", "Middle AI detail.", "Last AI detail."})
        self.assertTrue(all(a.evidence and a.origin == "ai_generated" for a in updated.annotations))
        self.assertEqual([updated.body[a.start:a.end] for a in updated.annotations], [a.quote for a in updated.annotations])

    def test_paragraph_insertion_references_cannot_replace_protected_human_text(self):
        original = self.page
        with self.assertRaisesRegex(LLMRequestError, "outside a recorded AI passage"):
            self.apply({"updates": [{"id": "P1", "text": "Changed human words.",
                "evidence": [{"quote": "Mara has blue eyes."}]}]})
        self.assertEqual(self.page, original)

    def test_add_between_human_paragraphs_while_revising_owned_text(self):
        updated, _, count = self.apply({"insertions": [{"before_id": "P2", "text": "New supported detail.",
            "evidence": [{"quote": "Mara has blue eyes."}]}], "updates": [{"id": "A1",
            "text": "Revised AI paragraph.\n\nAnother AI paragraph.",
            "evidence": [{"quote": "She lives beside the river."}]}]})
        self.assertEqual(updated.body, "Protected author secret.\n\nNew supported detail.\n\nRevised AI paragraph.\n\nAnother AI paragraph.\n\nHuman draft.")
        self.assertEqual((count, self.report.inserted, self.report.updated), (0, 1, 1))
        self.assertEqual(len(updated.annotations), 4)
        self.assertEqual(updated.annotations[-1].id, self.page.annotations[-1].id)

    def test_new_paragraph_spacing_preserves_legacy_crlf_source(self):
        self.page = replace(self.page, body="Human first.\r\n\r\nHuman last.", annotations=())
        updated, _, count = self.apply({"insertions": [{"after_id": "P1", "text": "AI detail.",
            "evidence": [{"quote": "Mara has blue eyes."}]}]})
        self.assertEqual(updated.body, "Human first.\n\nAI detail.\r\n\r\nHuman last.")
        self.assertEqual(count, 0)
        self.assertEqual(updated.annotations[0].quote, "AI detail.")

    def test_missing_and_invalid_evidence_produce_truthful_actionable_no_change_result(self):
        updated, summary, count = self.apply({"summary": "Populated Mara with lots of details.", "updates": [
            {"id": "A1", "text": "False claim", "evidence": []},
            {"id": "A2", "text": "False claim", "evidence": [{"quote": "Invented quotation"}]}]})
        self.assertEqual(updated.body, self.page.body)
        self.assertEqual(updated.annotations, self.page.annotations)
        self.assertEqual(count, 2)
        self.assertIn("No page text or review suggestions were changed", summary)
        self.assertIn("2 had no exact", summary)
        self.assertIn("Update from manuscript", summary)
        self.assertNotIn("Populated Mara", summary)
        self.assertEqual([r.reason for r in self.report.rejected], ["evidence", "evidence"])

    def test_quote_only_resolution_rejects_ambiguity_historical_and_wrong_explicit_ids(self):
        self.project.scenes[1].text = "Mara has blue eyes."
        for evidence in [[{"quote": "Mara has blue eyes."}],
            [{"source_id": str(uuid4()), "quote": "She lives beside the river."}],
            [{"source_type": "wiki", "quote": "She lives beside the river."}]]:
            updated, _, count = self.apply({"updates": [{"id": "A1", "text": "Blue eyes", "evidence": evidence}]})
            self.assertEqual(updated.body, self.page.body); self.assertEqual(count, 1)
        updated, _, count = self.apply({"updates": [{"id": "A1", "text": "Blue eyes", "evidence": [
            {"scene_id": str(self.project.scenes[0].id), "quote": "Mara has blue eyes."}]}]})
        self.assertEqual(count, 0); self.assertIn("Blue eyes", updated.body)
        self.project.scenes[1].historical = True
        self.project.scenes[1].text = "An old quote."
        context, _ = prepare_wiki(self.project, self.page, "Biography")
        updated, _, count = self.apply({"updates": [{"id": "A1", "text": "Old fact", "evidence": [{"quote": "An old quote."}]}]}, context)
        self.assertEqual(updated.body, self.page.body); self.assertEqual(count, 1)

    def test_rejections_distinguish_bad_anchor_inside_ai_and_inappropriate_review(self):
        evidence = [{"quote": "Mara has blue eyes."}]
        self.apply({"insertions": [{"after": "Missing", "text": "x", "evidence": evidence},
            {"after": "Protected author secret.\n\nHuman", "text": "x", "evidence": evidence}],
            "suggestions": [{"quote": "Protected author secret.\n\nHuman draft.", "explanation": "Edit", "evidence": evidence}]})
        self.assertEqual([r.reason for r in self.report.rejected], ["anchor", "ai_anchor", "review_ai"])
        repair = repair_wiki_prompt(self.prompt, {"updates": []}, self.report)
        self.assertIn('"reason": "ai_anchor"', repair)
        self.assertIn("CURRENT MANUSCRIPT", repair)

    def test_identical_update_is_not_reported_as_a_content_change(self):
        updated, summary, _ = self.apply({"updates": [{"id": "A1", "text": "Human draft.",
            "evidence": [{"quote": "Mara has blue eyes."}]}]})
        self.assertEqual(updated.annotations, self.page.annotations)
        self.assertEqual(self.report.applied, 0)
        self.assertIn("No page text", summary)


class WikiCorrectionRoutesTest(unittest.TestCase):
    def setUp(self):
        from tests.test_wiki_ai import WikiAIRoutesTest
        fixture = WikiAIRoutesTest(); fixture.setUp(); self.addCleanup(fixture.doCleanups)
        for name in ("app", "client", "store", "scene"):
            setattr(self, name, getattr(fixture, name))
        page = self.store.get().wiki_pages[0]
        self.page = replace(page, annotations=set_ai_maintenance(page.body, (), 0, len(page.body), True, str(uuid4())))
        self.store.get().wiki_pages[0] = self.page
        self.provider = self.app.extensions["llm_registry"].get("openai_compatible")
        self.invalid = {"summary": "Populated the page!", "updates": [{"id": "A1", "text": "Blue eyes", "evidence": []}]}
        self.valid = {"updates": [{"id": "A1", "text": "Blue eyes", "evidence": [{"quote": "Mara has blue eyes."}]}]}

    def generate(self):
        return self.client.post(f"/ai/wiki/{self.page.id}", json={"action": "populate", "purpose": "Biography", "page_hash": page_hash(self.page)})

    def test_one_corrected_response_becomes_signed_proposal_without_mutating_before_apply(self):
        with patch.object(self.provider, "complete", side_effect=[json.dumps(self.invalid), json.dumps(self.valid)]) as complete:
            response = self.generate()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(complete.call_count, 2)
        self.assertIn("CORRECTION:", complete.call_args_list[1].args[-1])
        self.assertEqual(self.store.get().wiki_pages[0], self.page)
        self.assertTrue(response.json["correction_attempted"])
        self.assertEqual(response.json["applied"], 1)
        applied = self.client.post(f"/wiki/page/{self.page.id}/ai/apply", json={"proposal": response.json["proposal"]})
        self.assertEqual(applied.status_code, 200)
        self.assertEqual(self.store.get().wiki_pages[0].body, "Blue eyes")

    def test_failed_correction_stops_at_two_calls_and_explains_unchanged_page(self):
        with patch.object(self.provider, "complete", return_value=json.dumps(self.invalid)) as complete:
            response = self.generate()
        self.assertEqual(complete.call_count, 2)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["applied"], 0)
        self.assertEqual(response.json["rejections"][0]["reason"], "evidence")
        self.assertIn("automatic correction did not produce", response.json["summary"])
        self.assertNotIn("Populated", response.json["summary"])
        self.assertEqual(self.store.get().wiki_pages[0], self.page)

    def test_partial_success_does_not_trigger_another_provider_call(self):
        mixed = {**self.valid, "insertions": [{"after": "", "text": "unsupported", "evidence": []}]}
        with patch.object(self.provider, "complete", return_value=json.dumps(mixed)) as complete:
            response = self.generate()
        self.assertEqual(complete.call_count, 1)
        self.assertEqual(response.json["applied"], 1)
        self.assertFalse(response.json["correction_attempted"])

    def test_repaired_response_is_still_rejected_if_author_edits_before_apply(self):
        with patch.object(self.provider, "complete", side_effect=[json.dumps(self.invalid), json.dumps(self.valid)]):
            response = self.generate()
        self.store.get().wiki_pages[0] = replace(self.page, body=self.page.body + "\n\nHuman addition.")
        result = self.client.post(f"/wiki/page/{self.page.id}/ai/apply", json={"proposal": response.json["proposal"]})
        self.assertEqual(result.status_code, 409)
        self.assertTrue(self.store.get().wiki_pages[0].body.endswith("Human addition."))
