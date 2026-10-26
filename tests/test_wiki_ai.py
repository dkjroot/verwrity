"""Wiki refresh must preserve human knowledge, provenance and source data."""

from copy import deepcopy
from dataclasses import replace
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from uuid import uuid4
import zipfile

from verwrity.ai.llm import LLMRegistry, LLMRequestError
from verwrity.ai.settings import UserAISettings
from verwrity.analysis.wiki import prepare_wiki, populate_wiki, page_hash, manuscript_hash
from verwrity.domain.story import StoryProject, WikiPage
from verwrity.domain.wiki_provenance import human_edit_annotations, read_annotations
from verwrity.project.archive import export_project, import_project
from verwrity.project.library import ProjectLibrary
from verwrity.project.preferences import UserPreferences
from verwrity.project.store import ProjectStore
from verwrity.project.text_analysis import UserTextAnalyses
from verwrity.web.app import create_app


class WikiPopulationTest(unittest.TestCase):
    def setUp(self):
        self.project = StoryProject.demo()
        self.project.scenes[0].text = "Mara has blue eyes. She lives beside the river."
        self.project.scenes[1].text = "Mara remembers her sister June."
        self.page = WikiPage(uuid4(), "Mara", "Human secret: Mara is immortal.\n\n## Appearance\n")
        self.project.wiki_pages = [self.page]
        self.settings = {"standard": "openai_compatible", "model": "test-local"}
        self.context, self.prompt = prepare_wiki(self.project, self.page, "Mara's life")
        self.evidence = [{"source_type": "scene", "source_id": str(self.project.scenes[0].id),
                          "quote": "Mara has blue eyes."}]

    def apply(self, page=None, **response):
        return populate_wiki(self.project, page or self.page, "Mara's life", response, self.context, self.settings)[0]

    def populated(self):
        return self.apply(insertions=[{"after": "## Appearance\n", "text": "- Blue eyes.\n", "evidence": self.evidence}])

    def test_population_preserves_human_text_and_cites_provenance(self):
        updated = self.populated()
        self.assertEqual(updated.body, self.page.body + "\n- Blue eyes.\n")
        self.assertEqual(updated.annotations[0].kind, "ai_text")
        self.assertEqual(updated.annotations[0].evidence[0].quote, "Mara has blue eyes.")
        self.assertEqual(updated.annotations[0].source_hash, manuscript_hash(self.project))
        self.assertEqual(self.project.wiki_pages[0], self.page)

    def test_insertion_between_human_paragraphs_and_unicode_mapping(self):
        page = replace(self.page, body="😀 Header\n\nHuman ending")
        updated = self.apply(page, insertions=[{"after": "😀 Header", "text": "\nAI detail", "evidence": self.evidence}])
        a = updated.annotations[0]
        self.assertEqual(updated.body[a.start:a.end], "AI detail")
        self.assertEqual(updated.body, "😀 Header\n\nAI detail\n\nHuman ending")

    def test_refresh_and_delete_only_recorded_ai_ranges(self):
        updated = self.populated()
        a = updated.annotations[0]
        refreshed = self.apply(updated, updates=[{"id": str(a.id), "text": "- Eyes: blue.\n", "evidence": self.evidence}])
        self.assertTrue(refreshed.body.startswith(self.page.body))
        self.assertEqual(refreshed.annotations[0].id, a.id)
        deleted = self.apply(refreshed, updates=[{"id": str(a.id), "text": "", "evidence": self.evidence}])
        self.assertEqual(deleted.body.rstrip("\n"), self.page.body.rstrip("\n"))
        self.assertTrue(deleted.body.startswith(self.page.body), "Existing human separators remain intact")
        self.assertEqual(deleted.annotations, ())

    def test_model_cannot_update_human_text(self):
        with self.assertRaisesRegex(LLMRequestError, "outside"):
            self.apply(updates=[{"id": str(self.page.id), "text": "Changed human secret", "evidence": self.evidence}])

    def test_unsupported_evidence_and_ambiguous_anchors_are_discarded(self):
        updated = self.apply(insertions=[{"after": "", "text": "Invented", "evidence": [dict(self.evidence[0], quote="Invented quote")]},
            {"after": "Missing", "text": "Wrong anchor", "evidence": self.evidence}])
        self.assertEqual(updated.body, self.page.body)
        self.assertEqual(updated.annotations, ())

    def test_historical_scenes_and_wiki_are_excluded(self):
        self.project.scenes[1].historical = True
        context, prompt = prepare_wiki(self.project, self.page, "Mara")
        self.assertNotIn("Mara remembers", prompt)
        self.assertEqual(context["wiki_ids"], set())
        bad = [{"source_type": "scene", "source_id": str(self.project.scenes[1].id), "quote": "Mara remembers her sister June."}]
        updated = populate_wiki(self.project, self.page, "Mara", {"insertions": [{"after": "", "text": "June", "evidence": bad}]}, context, self.settings)[0]
        self.assertEqual(updated.body, self.page.body)

    def test_human_review_is_separate_and_cannot_highlight_ai_text(self):
        updated = self.apply(suggestions=[{"quote": "Mara is immortal.", "explanation": "The manuscript does not establish this; keep author knowledge distinct.", "evidence": self.evidence}])
        self.assertEqual(updated.body, self.page.body)
        self.assertEqual(updated.annotations[0].kind, "suggestion")
        populated = self.populated()
        result = self.apply(populated, suggestions=[{"quote": "Blue eyes.", "explanation": "Change", "evidence": self.evidence}])
        self.assertEqual(len(result.annotations), 1)

    def test_human_edits_protect_modified_ai_and_preserve_untouched_ai(self):
        updated = self.populated()
        self.assertEqual(human_edit_annotations(updated.body, updated.body.replace("Blue", "Green"), updated.annotations), ())
        new = "New human notes\n" + updated.body
        mapped = human_edit_annotations(updated.body, new, updated.annotations)
        self.assertEqual(mapped[0].id, updated.annotations[0].id)
        self.assertEqual(new[mapped[0].start:mapped[0].end], mapped[0].quote)

    def test_duplicate_updates_and_insertion_inside_ai_are_rejected(self):
        updated = self.populated(); a = updated.annotations[0]
        with self.assertRaisesRegex(LLMRequestError, "overlapping"):
            self.apply(updated, updates=[{"id": str(a.id), "text": "x", "evidence": self.evidence}] * 2)
        result = self.apply(updated, insertions=[{"after": "Blue", "text": "x", "evidence": self.evidence}])
        self.assertEqual(result.body, updated.body)

    def test_source_limit_refuses_silent_sampling(self):
        self.project.scenes[0].text = "x" * 1_000_001
        with self.assertRaisesRegex(ValueError, "No partial"):
            prepare_wiki(self.project, self.page, "Mara")

    def test_archive_roundtrip_and_recovery_preserve_ai_ownership(self):
        page = self.populated()
        self.project.wiki_pages[0] = page
        _, data = export_project(self.project)
        self.assertEqual(import_project(data), self.project)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "draft.zip"
            ProjectStore(self.project, persist_path=path).commit()
            self.assertEqual(ProjectStore(persist_path=path).get(), self.project)

    def test_archive_v2_missing_provenance_defaults_to_human(self):
        _, data = export_project(self.project)
        source = zipfile.ZipFile(io.BytesIO(data)); output = io.BytesIO()
        with zipfile.ZipFile(output, "w") as target:
            for name in source.namelist():
                content = source.read(name)
                if name == "manifest.json":
                    manifest = json.loads(content); manifest["archive_version"] = 2; content = json.dumps(manifest).encode()
                if name == "wiki.json":
                    pages = json.loads(content)
                    for p in pages: p.pop("annotations"); p.pop("purpose")
                    content = json.dumps(pages).encode()
                target.writestr(name, content)
        loaded = import_project(output.getvalue())
        self.assertEqual(loaded.wiki_pages[0].annotations, ())

    def test_corrupt_provenance_is_rejected(self):
        page = self.populated(); record = page.annotations[0].as_dict(); record["start"] += 1
        with self.assertRaises(ValueError): read_annotations([record], page.body)
        with self.assertRaises(ValueError): read_annotations([page.annotations[0].as_dict()] * 2, page.body)


class WikiAIRoutesTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(); self.addCleanup(self.directory.cleanup)
        root = Path(self.directory.name)
        project = StoryProject.demo(); project.scenes[0].text = "Mara has blue eyes."
        project.wiki_pages = [WikiPage(uuid4(), "Mara", "Human secret.")]
        self.app = create_app(ProjectStore(project))
        self.app.config.update(TESTING=True, PROJECT_DRAFT_ROOT=root / "drafts", PROJECT_LIBRARY=ProjectLibrary(root))
        self.app.extensions.update(ai_settings=UserAISettings(root), user_preferences=UserPreferences(root), text_analyses=UserTextAnalyses(root))
        self.calls = []
        owner = self
        class FakeLLM:
            standard_id = "openai_compatible"
            display_name = "test"
            default_endpoint = "http://127.0.0.1:1234/v1"
            def complete(self, endpoint, model, token, prompt):
                owner.calls.append(prompt)
                return json.dumps(owner.response)
        self.app.extensions["llm_registry"] = LLMRegistry([FakeLLM()])
        self.app.extensions["ai_settings"].update_llm("local-user", {"standard": "openai_compatible",
            "endpoint": "http://127.0.0.1:1234/v1", "model": "test"}, self.app.extensions["llm_registry"])
        self.client = self.app.test_client(); self.client.get("/")
        self.store = next(iter(self.app.config["PROJECT_STORES"].values()))
        self.page = self.store.get().wiki_pages[0]; self.scene = self.store.get().scenes[0]
        self.response = {"summary": "Added appearance.", "insertions": [{"after": "Human secret.", "text": "\nBlue eyes.",
            "evidence": [{"source_type": "scene", "source_id": str(self.scene.id), "quote": self.scene.text}]}]}

    def generate(self):
        return self.client.post(f"/ai/wiki/{self.page.id}", json={"action": "populate", "purpose": "Mara's biography", "page_hash": page_hash(self.page)})

    def apply(self, result):
        return self.client.post(f"/wiki/page/{self.page.id}/ai/apply", json={"proposal": result.json["proposal"]})

    def test_generate_does_not_mutate_cancelled_request_and_apply_persists(self):
        before = deepcopy(self.store.get()); result = self.generate()
        self.assertEqual(result.status_code, 200); self.assertEqual(self.store.get(), before)
        applied = self.apply(result); self.assertEqual(applied.status_code, 200)
        page = self.store.get().wiki_pages[0]
        self.assertTrue(page.body.startswith(self.page.body)); self.assertEqual(len(page.revisions), 1)
        self.assertEqual(self.scene.text, before.scenes[0].text)
        self.assertEqual(import_project(export_project(self.store.get())[1]), self.store.get())
        self.assertEqual(self.apply(result).status_code, 409, "Proposal replay must not duplicate additions")

    def test_stale_manuscript_page_and_project_reject_apply(self):
        for change in ("manuscript", "page", "project"):
            with self.subTest(change=change):
                result = self.generate(); self.assertEqual(result.status_code, 200)
                before = deepcopy(self.store.get())
                if change == "manuscript": self.scene.text += " changed"
                if change == "page": self.store.get().wiki_pages[0] = replace(self.page, body="Changed human note")
                if change == "project": self.store.get().project_id = uuid4()
                self.assertEqual(self.apply(result).status_code, 409)
                self.store.rollback(before, self.store.generation, False)
                self.scene = self.store.get().scenes[0]

    def test_consent_missing_purpose_and_stale_hash_make_no_provider_call(self):
        for payload in ({"action": "populate", "purpose": ""}, {"action": "populate", "purpose": "Mara", "page_hash": "old"}):
            self.assertIn(self.client.post(f"/ai/wiki/{self.page.id}", json=payload).status_code, (400, 409))
        with patch.object(self.app.extensions["ai_settings"], "load", return_value={"llm": {"endpoint": "https://example.test/v1", "remote_consent_endpoint": "https://other.test/v1"}}):
            self.assertEqual(self.generate().status_code, 403)
        self.assertEqual(self.calls, [])

    def test_purpose_suggestion_does_not_mutate_page(self):
        self.response = {"purpose": "Mara's background and appearance"}
        result = self.client.post(f"/ai/wiki/{self.page.id}", json={"action": "suggest", "purpose": "", "page_hash": page_hash(self.page)})
        self.assertEqual(result.status_code, 200); self.assertIn("Mara", result.json["purpose"])
        self.assertEqual(self.store.get().wiki_pages[0], self.page)

    def test_human_save_restore_and_rename_preserve_provenance(self):
        self.apply(self.generate()); page = self.store.get().wiki_pages[0]
        response = self.client.post(f"/wiki/page/{page.id}/save", data={"title": "Mara Vale", "body": page.body,
            "page_hash": page_hash(page), "purpose": "Biography"})
        self.assertEqual(response.status_code, 302)
        renamed = self.store.get().wiki_pages[0]; self.assertEqual(renamed.annotations, page.annotations)
        self.client.post(f"/wiki/page/{page.id}/save", data={"title": renamed.title, "body": renamed.body.replace("Blue", "Green")})
        edited = self.store.get().wiki_pages[0]; self.assertEqual(edited.annotations, ())
        self.client.post(f"/wiki/page/{page.id}/restore/{edited.revisions[-1].id}")
        self.assertEqual(self.store.get().wiki_pages[0].annotations, page.annotations)

    def test_renaming_inbound_ai_links_and_todo_append_preserve_ownership(self):
        from verwrity.web.routes.scenes import _append_todo
        evidence = self.response["insertions"][0]["evidence"]
        todo = WikiPage(uuid4(), "TODO", "Human task.\n")
        context, _ = prepare_wiki(self.store.get(), todo, "Tasks")
        updated = populate_wiki(self.store.get(), todo, "Tasks", {"insertions": [{"after": "Human task.\n",
            "text": "- [[Mara]]: Blue eyes.\n", "evidence": evidence}]}, context, {"standard": "openai_compatible", "model": "test"})[0]
        self.store.get().wiki_pages.append(updated)
        self.client.post(f"/wiki/page/{self.page.id}/save", data={"title": "Mara Vale", "body": self.page.body})
        linked = self.store.get().wiki_pages[1]
        self.assertIn("[[Mara Vale]]", linked.annotations[0].quote)
        self.assertEqual(linked.annotations[0].id, updated.annotations[0].id)
        appended = _append_todo(self.store.get(), self.scene, "Mara", "A human task")
        self.assertEqual(appended.annotations, linked.annotations)
        self.assertEqual(appended.revisions[-1].annotations, linked.annotations)
        self.assertEqual(import_project(export_project(self.store.get())[1]), self.store.get())

    def test_persistence_failure_rolls_back_and_bad_tokens_fail(self):
        result = self.generate()
        with patch.object(self.store, "commit", side_effect=OSError("disk full")):
            self.assertEqual(self.apply(result).status_code, 503)
        self.assertEqual(self.store.get().wiki_pages[0], self.page)
        self.assertEqual(self.client.post(f"/wiki/page/{self.page.id}/ai/apply", json={"proposal": "fake"}).status_code, 400)

    def test_stale_human_save_rejected_without_changing_page(self):
        response = self.client.post(f"/wiki/page/{self.page.id}/save", data={"title": "Mara", "body": "Unsaved human edit", "page_hash": "old"})
        self.assertEqual(response.status_code, 409); self.assertEqual(self.store.get().wiki_pages[0], self.page)

    def test_suggestion_dismissal_persists(self):
        self.response = {"suggestions": [{"quote": "Human secret.", "explanation": "Add appearance details here.", "evidence": self.response["insertions"][0]["evidence"]}]}
        self.apply(self.generate()); page = self.store.get().wiki_pages[0]; a = page.annotations[0]
        result = self.client.post(f"/wiki/page/{page.id}/suggestion/{a.id}/dismiss", json={"page_hash": page_hash(page)})
        self.assertEqual(result.status_code, 200); self.assertEqual(self.store.get().wiki_pages[0].annotations[0].status, "dismissed")
        self.page = self.store.get().wiki_pages[0]
        self.apply(self.generate()); self.assertEqual(self.store.get().wiki_pages[0].annotations[0].status, "dismissed")
        self.page = self.store.get().wiki_pages[0]; self.response = {}
        self.apply(self.generate()); self.assertEqual(self.store.get().wiki_pages[0].annotations[0].status, "dismissed")


if __name__ == "__main__":
    unittest.main()
