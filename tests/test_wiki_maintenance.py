"""Wiki update permission does not fabricate authorship or change source text."""
from dataclasses import replace
from io import BytesIO
import json
import unittest
from uuid import uuid4
import zipfile

from verwrity.analysis.wiki import page_hash, prepare_wiki, populate_wiki
from verwrity.domain.story import StoryProject, WikiPage
from verwrity.domain.wiki_provenance import human_edit_annotations, read_annotations, set_ai_maintenance
from verwrity.project.archive import export_project, import_project


class WikiMaintenanceTest(unittest.TestCase):
    def setUp(self):
        self.body = "Protected 😀 opening.\n\nHuman draft to maintain.\n\nProtected ending."
        self.start = self.body.index("Human")
        self.end = self.body.index("\n\nProtected ending")
        self.identity = str(uuid4())

    def delegate(self, body=None, records=(), start=None, end=None):
        return set_ai_maintenance(body or self.body, records, self.start if start is None else start,
            self.end if end is None else end, True, self.identity)

    def test_selection_gets_permission_with_human_origin_and_no_invented_evidence(self):
        records = self.delegate()
        self.assertEqual(len(records), 1)
        a = records[0]
        self.assertEqual(a.quote, "Human draft to maintain.")
        self.assertEqual(a.origin, "human_delegated")
        self.assertEqual((a.provider, a.model, a.source_hash, a.evidence), ("", "", "", ()))
        self.assertEqual(read_annotations([a.as_dict()], self.body), records)

    def test_partial_selection_protects_adjacent_words_and_can_be_revoked(self):
        records = self.delegate(start=self.start + 6, end=self.end - 1)
        self.assertEqual(records[0].quote, "draft to maintain")
        revoked = set_ai_maintenance(self.body, records, self.start + 6, self.end - 1, False, str(uuid4()))
        self.assertEqual(revoked, ())

    def test_revoking_middle_retains_permission_and_origin_of_surrounding_parts(self):
        records = self.delegate()
        start = self.start + 6
        revoked = set_ai_maintenance(self.body, records, start, start + 5, False, str(uuid4()))
        self.assertEqual([a.quote for a in revoked], ["Human ", " to maintain."])
        self.assertEqual(len({a.id for a in revoked}), 2)
        self.assertTrue(all(a.origin == "human_delegated" for a in revoked))
        self.assertEqual(read_annotations([a.as_dict() for a in revoked], self.body), revoked)

    def test_permission_replay_handles_unicode_and_content_edits_before_assignment(self):
        prefix = "A new 😀 note.\n\n"
        new = prefix + self.body
        edits = [{"start": 0, "end": 0, "text": prefix}, {"kind": "ai_maintenance",
            "start": self.start + len(prefix), "end": self.end + len(prefix), "enabled": True, "id": self.identity}]
        records = human_edit_annotations(self.body, new, (), edits)
        self.assertEqual(records[0].quote, "Human draft to maintain.")
        self.assertEqual(new[records[0].start:records[0].end], records[0].quote)

    def test_enter_separator_then_human_text_preserves_ai_block_at_end(self):
        body = "An AI-maintained paragraph."
        records = self.delegate(body=body, start=0, end=len(body))
        new = body + "\n\nHuman ending."
        edits = [{"start": len(body), "end": len(body), "text": "\n\n"},
                 {"start": len(body) + 2, "end": len(body) + 2, "text": "Human ending."}]
        self.assertEqual(human_edit_annotations(body, new, records, edits), records)

    def test_old_browser_tabs_without_normalization_log_can_save_crlf_entries(self):
        body = "First 😀 AI.\r\n\r\nSecond AI."
        records = self.delegate(body=body, start=0, end=len(body))
        normalized = body.replace("\r\n", "\n")
        new = normalized + "\n\nHuman ending."
        saved = human_edit_annotations(body, new, records,
            [{"start": len(normalized), "end": len(normalized), "text": "\n\nHuman ending."}])
        self.assertEqual([a.quote for a in saved], ["First 😀 AI.", "Second AI."])
        for a in saved: self.assertEqual(new[a.start:a.end], a.quote)

    def test_unverifiable_edit_explains_safety_and_concrete_recovery(self):
        with self.assertRaises(ValueError) as raised:
            human_edit_annotations(self.body, self.body + " untracked edit", self.delegate(), [])
        message = str(raised.exception)
        self.assertIn("page was not saved", message)
        self.assertIn("text is still in the edit box", message)
        self.assertIn("Copy it somewhere safe, reload", message)

    def test_editing_delegated_paragraph_adopts_it_again(self):
        records = self.delegate()
        edited = self.body[:self.start] + "Changed " + self.body[self.start:]
        self.assertEqual(human_edit_annotations(self.body, edited, records,
            [{"start": self.start, "end": self.start, "text": "Changed "}]), ())

    def test_generated_origin_without_evidence_and_false_delegation_claims_are_rejected(self):
        a = self.delegate()[0]
        for invalid in [replace(a, origin="ai_generated"), replace(a, provider="model"), replace(a, origin="unknown")]:
            with self.assertRaises(ValueError): read_annotations([invalid.as_dict()], self.body)
        for identity in [None, 3, "not-a-uuid"]:
            with self.assertRaises(ValueError):
                set_ai_maintenance(self.body, (), self.start, self.end, True, identity)

    def test_current_version_preserves_delegated_origin_and_permission(self):
        project = StoryProject("Permission", wiki_pages=[WikiPage(uuid4(), "Notes", self.body, annotations=self.delegate())])
        payload = export_project(project)[1]
        self.assertEqual(import_project(payload), project)
        with zipfile.ZipFile(BytesIO(payload)) as archive:
            self.assertEqual(json.loads(archive.read("manifest.json"))["archive_version"], 10)

    def test_legacy_version_three_without_origin_keeps_original_text_and_stable_ids(self):
        from tests.test_wiki_paragraphs import WikiParagraphTest
        fixture = WikiParagraphTest(); fixture.setUp()
        project = StoryProject("Legacy", wiki_pages=[WikiPage(uuid4(), "Legacy", fixture.body, annotations=(fixture.record,))])
        output = BytesIO()
        with zipfile.ZipFile(BytesIO(export_project(project)[1])) as archive, zipfile.ZipFile(output, "w") as target:
            for name in archive.namelist():
                data = archive.read(name)
                if name == "manifest.json":
                    manifest = json.loads(data); manifest["archive_version"] = 3; data = json.dumps(manifest)
                elif name == "wiki.json":
                    pages = json.loads(data)
                    pages[0]["annotations"] = [fixture.record.as_dict()]
                    pages[0]["annotations"][0].pop("origin")
                    data = json.dumps(pages)
                target.writestr(name, data)
        loaded = import_project(output.getvalue())
        self.assertEqual(loaded, project)
        self.assertEqual(import_project(export_project(loaded)[1]), project)


class WikiMaintenanceRoutesTest(unittest.TestCase):
    def setUp(self):
        from tests.test_wiki_ai import WikiAIRoutesTest
        fixture = WikiAIRoutesTest(); fixture.setUp(); self.addCleanup(fixture.doCleanups)
        for name in ("app", "client", "store", "page", "scene", "response"):
            setattr(self, name, getattr(fixture, name))

    def test_permission_only_save_creates_history_and_refresh_can_update_only_selected_text(self):
        page = self.store.get().wiki_pages[0]
        edits = [{"kind": "ai_maintenance", "start": 0, "end": len(page.body), "enabled": True, "id": str(uuid4())}]
        response = self.client.post(f"/wiki/page/{page.id}/save", data={"title": page.title, "body": page.body,
            "page_hash": page_hash(page), "authorship_edits": json.dumps(edits)})
        self.assertEqual(response.status_code, 302)
        saved = self.store.get().wiki_pages[0]
        self.assertEqual(saved.body, page.body)
        self.assertEqual(saved.annotations[0].origin, "human_delegated")
        self.assertEqual(len(saved.revisions), len(page.revisions) + 1)
        self.assertEqual(saved.revisions[-1].annotations, ())
        self.assertEqual(import_project(export_project(self.store.get())[1]), self.store.get())
        context, prompt = prepare_wiki(self.store.get(), saved, "Biography")
        self.assertIn("human_delegated", prompt)
        response = {"updates": [{"id": str(saved.annotations[0].id), "text": "A supported update.",
            "evidence": self.response["insertions"][0]["evidence"]}]}
        updated = populate_wiki(self.store.get(), saved, "Biography", response, context,
            {"standard": "openai_compatible", "model": "test"})[0]
        self.assertEqual(updated.body, "A supported update.")
        self.assertEqual(updated.annotations[0].origin, "ai_generated")
        self.assertTrue(updated.annotations[0].evidence)
        restored = self.client.post(f"/wiki/page/{page.id}/restore/{saved.revisions[-1].id}")
        self.assertEqual(restored.status_code, 302)
        self.assertEqual(self.store.get().wiki_pages[0].annotations, ())
