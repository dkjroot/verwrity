"""Project words are author-approved, portable and reused without prose writes."""
from copy import deepcopy
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
from uuid import uuid4
import json
import unittest
import zipfile

from verwrity.analysis.import_vocabulary import discover
from verwrity.analysis.spelling import SpellChecker
from verwrity.ai.ocr import cleanup_prompt, review_corrections
from verwrity.domain.project_words import checked_project_words, known_project_words, spelling_terms
from verwrity.domain.story import StoryProject, WikiPage, Scene
from verwrity.project.archive import export_project, import_project
from verwrity.project.library import ProjectLibrary
from verwrity.project.store import ProjectStore
from tests import test_ocr as base


class WordTests(unittest.TestCase):
    def project(self):
        project = StoryProject.demo()
        project.scenes = [Scene(uuid4(), "Current", text="Maridel crossed Qelvar. Qelvra waited."),
            Scene(uuid4(), "Old", text="Historicalzzz", historical=True)]
        project.wiki_pages = [WikiPage(uuid4(), "Maridel", "Human facts.", aliases=("Mari",))]
        project.project_words = ("Qelvar",)
        return project

    def test_local_candidates_group_neighbours_and_retain_sources_without_selecting(self):
        project = self.project(); before = deepcopy(project)
        result = discover(project, ["QeIvar met Maridel."], [], SpellChecker(["crossed", "waited", "met"]))
        items = {item["term"]: item for group in result["groups"] for item in group}
        self.assertIn("Wiki title", items["Maridel"]["sources"])
        self.assertIn("Project words", items["Qelvar"]["sources"])
        self.assertIn("Import section 1", items["QeIvar"]["sources"])
        self.assertNotIn("Historicalzzz", items)
        self.assertTrue(any({"Qelvar", "Qelvra"} <= {item["term"] for item in group} for group in result["groups"]))
        self.assertEqual(project, before)
        with self.assertRaises(ValueError): discover(project, ["x" * 20001], [], SpellChecker(["word"]))

    def test_project_words_are_known_including_wiki_alias_and_phrase_components(self):
        project = self.project(); project.project_words += ("House Valrien",)
        checker = SpellChecker(["the"])
        for word in ("Qelvar", "Maridel", "Mari", "Valrien"):
            self.assertTrue(checker.is_correct(word, spelling_terms(project)))
        self.assertFalse(checker.is_correct("Qelvra", spelling_terms(project)), "unaccepted scan variant remains unknown")
        self.assertEqual(checked_project_words(["Qelvar", "qelvar"]), ("Qelvar",))
        for words in (["bad\nword"], [""], ["x"] * 1501):
            with self.assertRaises(ValueError): checked_project_words(words)

    def test_collector_preserves_compounds_and_contractions_and_uses_known_words(self):
        project = self.project()
        project.project_words += ("Stone‑Warden",)
        project.scenes[0].text = "Maridel’s Stone-Wardenʼs well‑known friends don‘t fear moon‑wyrms."
        result = discover(project, [], [], SpellChecker(["well", "known", "friends", "don't", "fear"]))
        items = {item["term"] for group in result["groups"] for item in group}
        self.assertIn("moon‑wyrms", items)
        for term in ("s", "Maridel’s", "Stone-Wardenʼs", "well‑known", "don‘t"):
            self.assertNotIn(term, items)
        self.assertTrue(SpellChecker(["word"]).is_correct("Stone-Warden’s", spelling_terms(project)))

    def test_archive_recovery_duplicate_and_older_archives(self):
        project = self.project(); _, data = export_project(project)
        self.assertEqual(import_project(data).project_words, ("Qelvar",))
        with zipfile.ZipFile(BytesIO(data)) as archive:
            self.assertEqual(json.loads(archive.read("project_words.json")), ["Qelvar"])
            files = {name: archive.read(name) for name in archive.namelist()}
        for version in (9, 10):
            output = BytesIO()
            with zipfile.ZipFile(output, "w") as archive:
                for name, content in files.items():
                    if name == "project_words.json": continue
                    if name == "manifest.json":
                        manifest = json.loads(content); manifest["archive_version"] = version; content = json.dumps(manifest)
                    archive.writestr(name, content)
            if version == 9: self.assertEqual(import_project(output.getvalue()).project_words, ())
            else:
                with self.assertRaises(ValueError): import_project(output.getvalue())
        with TemporaryDirectory() as directory:
            path = Path(directory) / "recovery.zip"
            ProjectStore(project, persist_path=path).commit()
            self.assertEqual(ProjectStore(persist_path=path).get().project_words, ("Qelvar",))
            copy = ProjectLibrary(Path(directory) / "library").duplicate("local-user", project, "Copy")
            self.assertEqual(import_project(copy.read_bytes()).project_words, ("Qelvar",))

    def test_approved_ocr_vocabulary_allows_only_small_anchored_name_repairs(self):
        raw = '{"edits":[{"before":"Qeiv","after":"Qelvar"}]}'
        self.assertEqual(review_corrections("Qeiv", raw)["text"], "Qeiv")
        self.assertEqual(review_corrections("Qeiv", raw, ["Qelvar"])["text"], "Qelvar")
        self.assertEqual(review_corrections("Something", '{"edits":[{"before":"Something","after":"Qelvar"}]}', ["Qelvar"])["text"], "Something")
        self.assertIn('"approved_vocabulary": ["Qelvar"]', cleanup_prompt("Qeiv", ["Qelvar"]))

    def test_ocr_and_dictation_agree_on_insertion_and_redundant_name_proposals(self):
        from verwrity.ai.dictate_draft import review_cleanup
        text = "He would wollow at Bloham Court."
        raw = json.dumps({"edits": [{"before": "wollow", "after": "wallow"},
            {"before": "Bloham", "after": "Bloxham"}, {"before": "Bloham Court", "after": "Bloxham Court"}]})
        for terms in ([], ["Bloxham"]):
            for review in (review_corrections, lambda text, raw, terms: review_cleanup(text, terms, raw)):
                result = review(text, raw, terms)
                self.assertEqual(result["text"], "He would wallow at Bloxham Court.")
                self.assertEqual(len(result["edits"]), 2, "identical name repairs apply once")

    def test_context_targets_one_or_all_matching_passages_for_author_review(self):
        from verwrity.ai.dictate_draft import review_cleanup
        context = "They reached Bloham Court that evening"
        text = context + ". Elsewhere Bloham remained unchanged. " + context + "."
        for review in (review_corrections, lambda text, raw, terms: review_cleanup(text, terms, raw)):
            with self.subTest(review=review):
                edit = {"before": "Bloham", "after": "Bloxham", "context": context}
                result = review(text, json.dumps({"edits": [edit]}), [])
                self.assertEqual(result["text"], text.replace(context, context.replace("Bloham", "Bloxham")))
                self.assertEqual(len(result["edits"]), 2)
                edit["context"] = "Elsewhere Bloham remained unchanged."
                result = review(text, json.dumps({"edits": [edit]}), [])
                self.assertEqual(result["text"], text.replace("Elsewhere Bloham", "Elsewhere Bloxham"))
                for bad_context in (None, "Bloham Court", "missing Bloham passage"):
                    edit.pop("context", None)
                    if bad_context is not None: edit["context"] = bad_context
                    self.assertEqual(review(text, json.dumps({"edits": [edit]}), [])["text"], text)


@unittest.skipUnless(base.Image, "Install image support for shared route fixture")
class WordRouteTests(unittest.TestCase):
    setUp = base.RouteTests.setUp

    def test_explicit_compound_dictionary_save_is_shared_and_portable(self):
        state = self.client.get("/project/words").json
        saved = self.client.post("/project/words", json={"project_id": state["project_id"], "version": state["version"],
            "words": ["Moon‑wyrm"], "dictionary_words": ["Moon‑wyrm"]})
        self.assertEqual(saved.status_code, 200)
        project = next(iter(self.app.config["PROJECT_STORES"].values())).get()
        self.assertIn("moon-wyrm", project.spelling_dictionary)
        self.assertTrue(SpellChecker(["word"]).is_correct("Moon‑wyrm’s", spelling_terms(project)))
        for path in ("/ai/ocr", "/ai/dictate-draft"):
            self.assertIn("Moon‑wyrm", self.client.get(path).json["terms"])
        self.assertIn("moon-wyrm", import_project(export_project(project)[1]).spelling_dictionary)

    def test_accepted_words_and_empty_wiki_creation_skip_titles_aliases_and_keep_prose(self):
        store = next(iter(self.app.config["PROJECT_STORES"].values())); project = store.get()
        project.wiki_pages = [WikiPage(uuid4(), "Maridel", "Protected human facts.", aliases=("Mari",))]
        state = self.client.get("/project/words").json
        saved = self.client.post("/project/words", json={"project_id": state["project_id"], "version": state["version"],
            "words": ["Mari", "Qelvar"], "create_wiki": True, "wiki_words": ["Mari", "Qelvar"]})
        self.assertEqual(saved.status_code, 200)
        self.assertEqual([page["title"] for page in saved.json["created"]], ["Qelvar"])
        self.assertEqual(saved.json["created"][0]["body"], "")
        self.assertEqual(project.wiki_pages[0].body, "Protected human facts.")
        self.assertEqual(project.scenes[0].text, "Canonical prose remains untouched.")
        self.assertEqual(self.client.post("/project/words", json={"project_id": state["project_id"], "version": state["version"], "words": []}).status_code, 409)
        scene = project.scenes[0]
        result = self.client.post(f"/scene/{scene.id}/spell-check", data={"scene_text": "Qelvar Qelvra Mari"}).json
        words = [item["word"] for item in result["annotations"]]
        self.assertNotIn("Qelvar", words); self.assertNotIn("Mari", words); self.assertIn("Qelvra", words)

    def test_failed_word_save_rolls_back_words_and_new_pages(self):
        self.assertEqual(self.client.post("/project/words", json=["invalid shape"]).status_code, 400)
        store = next(iter(self.app.config["PROJECT_STORES"].values())); before = deepcopy(store.get())
        state = self.client.get("/project/words").json
        with patch.object(store, "commit", side_effect=OSError("fixture")):
            response = self.client.post("/project/words", json={"project_id": state["project_id"], "version": state["version"], "words": ["Qelvar"], "create_wiki": True})
        self.assertEqual(response.status_code, 503)
        self.assertEqual(store.get(), before)

    def test_scan_is_local_and_cleanup_only_receives_selected_vocabulary(self):
        state = self.client.get("/project/words").json
        with patch("verwrity.ai.ocr.OCRRegistry.get", side_effect=AssertionError("No OCR during scan")):
            response = self.client.post("/ai/import-vocabulary", json={"project_id": state["project_id"], "sections": ["QeIvar met Qelvar."], "selected": []})
            self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        self.app.extensions["ai_settings"].update_llm("local-user", {"endpoint": "localhost:8080", "model": "fixture"}, self.app.extensions["llm_registry"])
        context = self.client.get("/ai/ocr").json
        client = self.app.extensions["llm_registry"].get("openai_compatible")
        with patch.object(type(client), "complete", return_value='{"edits":[]}') as call:
            result = self.client.post("/ai/ocr/cleanup", json={"project_id": context["project_id"], "page_id": self.page,
                "configuration": context["configurations"]["llm"], "text": "Qeiv", "terms": ["Qelvar"]})
        self.assertEqual(result.status_code, 200)
        self.assertIn('"approved_vocabulary": ["Qelvar"]', call.call_args.args[3])
        self.assertNotIn("Canonical prose", call.call_args.args[3])
