"""Fine wiki authorship follows actual author edit positions, never quote guesses."""

from dataclasses import replace
import json
import unittest
from uuid import uuid4

from verwrity.analysis.wiki import prepare_wiki, populate_wiki, page_hash
from verwrity.domain.story import WikiPage, WikiRevision
from verwrity.domain.wiki_provenance import WikiAnnotation, WikiEvidence, human_edit_annotations
from verwrity.project.archive import export_project, import_project


class WikiParagraphTest(unittest.TestCase):
    def setUp(self):
        self.body = "First AI paragraph.\n\nSecond AI paragraph.\n\nThird AI paragraph."
        self.record = WikiAnnotation(uuid4(), "ai_text", 0, len(self.body), self.body, uuid4(),
            "source", "test", "local", "2026-10-02", (WikiEvidence(uuid4(), "Source evidence"),))
        self.page = WikiPage(uuid4(), "Page", self.body, annotations=(self.record,))

    def apply(self, start, end, text, old=None, records=None):
        old = self.body if old is None else old
        new = old[:start] + text + old[end:]
        records = self.page.annotations if records is None else records
        return new, human_edit_annotations(old, new, records, [{"start": start, "end": end, "text": text}])

    def test_existing_ai_pages_and_revisions_split_into_stable_paragraph_ids(self):
        self.assertEqual([a.quote for a in self.page.annotations],
            ["First AI paragraph.", "Second AI paragraph.", "Third AI paragraph."])
        self.assertEqual(self.page.annotations[0].id, self.record.id)
        self.assertEqual(WikiPage(self.page.id, "Page", self.body, annotations=(self.record,)).annotations, self.page.annotations)
        revision = WikiRevision(uuid4(), "Page", self.body, annotations=(self.record,))
        self.assertEqual(revision.annotations, self.page.annotations)

    def test_typing_adopts_one_paragraph_and_retains_both_neighbours(self):
        position = self.body.index("Second") + 6
        new, records = self.apply(position, position, " edited")
        self.assertEqual([a.id for a in records], [self.page.annotations[0].id, self.page.annotations[2].id])
        for a in records: self.assertEqual(new[a.start:a.end], a.quote)

    def test_human_paragraph_inserted_between_ai_paragraphs_does_not_adopt_neighbours(self):
        position = self.body.index("Second")
        new, records = self.apply(position, position, "My own paragraph.\n\n")
        self.assertEqual([a.id for a in records], [a.id for a in self.page.annotations])
        self.assertEqual(len(records), 3)
        self.assertNotIn("My own paragraph.", [a.quote for a in records])
        for a in records: self.assertEqual(new[a.start:a.end], a.quote)

    def test_deleting_one_paragraph_keeps_other_ai_paragraphs(self):
        start = self.body.index("Second"); end = self.body.index("Third")
        new, records = self.apply(start, end, "")
        self.assertEqual([a.quote for a in records], ["First AI paragraph.", "Third AI paragraph."])
        for a in records: self.assertEqual(new[a.start:a.end], a.quote)

    def test_inline_insert_and_paragraph_merge_adopt_only_affected_paragraphs(self):
        _, prefix = self.apply(self.body.index("Second"), self.body.index("Second"), "Human prefix: ")
        self.assertEqual(len(prefix), 2)
        start = self.body.index("\n\n")
        _, merged = self.apply(start, start + 2, " ")
        self.assertEqual([a.quote for a in merged], ["Third AI paragraph."])

    def test_duplicate_ai_paragraphs_keep_correct_identity_on_insertion_and_edit(self):
        page = WikiPage(uuid4(), "Duplicates", "Same.\n\nSame.", annotations=(replace(self.record,
            quote="Same.\n\nSame.", start=0, end=12),))
        new, records = self.apply(0, 0, "Same.\n\n", old=page.body, records=page.annotations)
        self.assertEqual([a.start for a in records], [7, 14])
        self.assertEqual([a.id for a in records], [a.id for a in page.annotations])
        new, records = self.apply(7, 7, "Edited ", old=new, records=records)
        self.assertEqual([a.id for a in records], [page.annotations[1].id])
        self.assertEqual(new[records[0].start:records[0].end], "Same.")

    def test_multiline_paragraph_and_independent_list_items(self):
        body = "## Heading\n\nOne wrapped\nparagraph here.\n\n- First bullet\n- Second bullet\n"
        page = WikiPage(uuid4(), "Blocks", body, annotations=(replace(self.record, start=0, end=len(body), quote=body),))
        self.assertEqual([a.quote for a in page.annotations],
            ["## Heading", "One wrapped\nparagraph here.", "- First bullet", "- Second bullet"])
        pos = body.index("wrapped")
        _, records = self.apply(pos, pos + 7, "edited", old=body, records=page.annotations)
        self.assertEqual(len(records), 3)
        pos = body.index("First bullet")
        _, records = self.apply(pos, pos + 5, "Edited", old=body, records=page.annotations)
        self.assertEqual(len(records), 3)
        self.assertEqual(records[-1].quote, "- Second bullet")

    def test_legacy_api_saves_map_paragraphs_without_adopting_an_entire_article(self):
        new = self.body.replace("Second AI", "Human-adopted")
        records = human_edit_annotations(self.body, new, self.page.annotations)
        self.assertEqual([a.quote for a in records], ["First AI paragraph.", "Third AI paragraph."])

    def test_invalid_edit_replay_cannot_claim_ai_ownership(self):
        with self.assertRaises(ValueError):
            human_edit_annotations(self.body, self.body + "new", self.page.annotations, [])
        with self.assertRaises(ValueError):
            human_edit_annotations(self.body, self.body, self.page.annotations, [{"start": -1, "end": 0, "text": ""}])

    def test_crlf_normalization_keeps_ai_ownership_and_unicode_offsets(self):
        body = "😀 First.\r\n\r\nSecond."
        page = WikiPage(uuid4(), "Unicode", body, annotations=(replace(self.record, start=0, end=len(body), quote=body),))
        normalized = body.replace("\r\n", "\n")
        records = human_edit_annotations(body, normalized, page.annotations, [{"kind": "normalize_newlines"}])
        self.assertEqual(len(records), 2)
        for a in records: self.assertEqual(normalized[a.start:a.end], a.quote)
        legacy = human_edit_annotations(body, normalized, page.annotations)
        self.assertEqual(legacy, records)


class WikiParagraphRoutesTest(unittest.TestCase):
    def setUp(self):
        from tests.test_wiki_ai import WikiAIRoutesTest
        fixture = WikiAIRoutesTest()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        for name in ("app", "client", "store", "page", "scene", "response", "generate", "apply"):
            setattr(self, name, getattr(fixture, name))

    def test_paragraph_save_refresh_archive_and_history_protect_adopted_text(self):
        evidence = self.response["insertions"][0]["evidence"]
        self.response["insertions"][0]["text"] = "\n\nFirst AI paragraph.\n\nSecond AI paragraph.\n\nThird AI paragraph."
        self.apply(self.generate())
        page = self.store.get().wiki_pages[0]
        start = page.body.index("Second") + 6
        edits = [{"start": start, "end": start, "text": " adopted"}]
        body = page.body[:start] + " adopted" + page.body[start:]
        response = self.client.post(f"/wiki/page/{page.id}/save", data={"title": page.title, "body": body,
            "page_hash": page_hash(page),
            "authorship_edits": json.dumps(edits)})
        self.assertEqual(response.status_code, 302)
        saved = self.store.get().wiki_pages[0]
        self.assertEqual([a.quote for a in saved.annotations], ["First AI paragraph.", "Third AI paragraph."])
        context, _ = prepare_wiki(self.store.get(), saved, "Biography")
        first = saved.annotations[0]
        refreshed = populate_wiki(self.store.get(), saved, "Biography", {"updates": [{"id": str(first.id),
            "text": "Updated first AI paragraph.", "evidence": evidence}]}, context,
            {"standard": "openai_compatible", "model": "test"})[0]
        self.assertIn("Second adopted AI paragraph.", refreshed.body)
        self.assertEqual(import_project(export_project(self.store.get())[1]), self.store.get())
        self.client.post(f"/wiki/page/{page.id}/restore/{saved.revisions[-1].id}")
        self.assertEqual(len(self.store.get().wiki_pages[0].annotations), 3)
