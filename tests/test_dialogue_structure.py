"""Speaker provenance, structural edits, snapshots and readable backups."""
from copy import deepcopy
from dataclasses import replace
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import Mock, patch
from uuid import uuid4
from io import BytesIO
from zipfile import ZipFile, ZIP_DEFLATED
import json
import threading

from verwrity.domain.dialogue import DialogueAttribution, dialogue_rows, update_dialogue_ranges
from verwrity.domain.scene_operations import split_scene, join_scenes
from verwrity.domain.scene_metadata import SceneMetadata
from verwrity.domain.story import Scene, StoryProject, ManuscriptComment, WikiPage, StoryboardColumn
from verwrity.analysis.dialogue import fingerprint, parse_extraction, parse_evaluation
from verwrity.analysis.text import TENSE_CHECKER, analyze_scene
from verwrity.project.archive import export_project, import_project
from verwrity.project.files import PROJECT_LOCK
from verwrity.project.library import ProjectLibrary
from verwrity.project.preferences import UserPreferences
from verwrity.project.text_analysis import UserTextAnalyses
from verwrity.project.store import ProjectStore
from verwrity.ai.settings import UserAISettings
from verwrity.ai.llm import LLMRegistry
from verwrity.web.app import create_app
from verwrity.web.services.workspace import scene_source_hash


def sample():
    speaker = WikiPage(uuid4(), "Mara", "Human facts remain here.", ("character",))
    first = Scene(uuid4(), "First", "First description", '😀 “Hello.”\n\n“Hello.” End.')
    second = Scene(uuid4(), "Second", "Second description", '“Goodbye.”')
    project = StoryProject("Voice story", scenes=[first, second], wiki_pages=[speaker])
    return project, first, second, speaker


class DialogueDomainTests(TestCase):
    def test_older_archive_defaults_and_invalid_speaker_reference(self):
        project, scene, _, speaker = sample()
        data = export_project(project)[1]
        output = BytesIO()
        with ZipFile(BytesIO(data)) as source, ZipFile(output, "w", ZIP_DEFLATED) as target:
            for name in source.namelist():
                if name == "scene_changes.json":
                    continue
                value = source.read(name)
                if name == "manifest.json":
                    manifest = json.loads(value); manifest["archive_version"] = 8; value = json.dumps(manifest)
                if name == "scenes.json":
                    records = json.loads(value)
                    for record in records: record.pop("dialogue")
                    value = json.dumps(records)
                target.writestr(name, value)
        self.assertEqual(import_project(output.getvalue()), project)
        scene.dialogue = [DialogueAttribution(uuid4(), uuid4(), 2, 10, "“Hello.”", "“Hello.”")]
        with self.assertRaises(ValueError): export_project(project)

    def test_split_join_roundtrip_and_history_preserve_source_and_ids(self):
        project, scene, _, speaker = sample()
        scene.metadata = SceneMetadata(tense="Past", purpose="Deliberate flashback")
        column = StoryboardColumn(uuid4(), "Chapter")
        project.storyboard_columns.append(column)
        project.set_storyboard_value(scene.id, column.id, "Chapter 2")
        start = scene.text.rindex("“Hello.”")
        scene.dialogue = [DialogueAttribution(uuid4(), speaker.id, start, start + 8, "“Hello.”", "“Hello.”")]
        # Correct the code point length, independently of UTF-16's emoji width.
        scene.dialogue[0] = replace(scene.dialogue[0], end=start + len("“Hello.”"))
        scene.comments = [ManuscriptComment(uuid4(), start, start + 8, "“Hello.”", "Later note"),
                          ManuscriptComment(uuid4(), None, None, "Gone", "Detached note", detached=True)]
        scene.comments[0].end = start + len("“Hello.”")
        before = deepcopy(scene)
        later = split_scene(project, scene, start, "Continuation", "Continued description")
        self.assertEqual(scene.id, before.id)
        self.assertEqual(scene.text + later.text, before.text)
        self.assertEqual(later.dialogue[0].id, before.dialogue[0].id)
        self.assertEqual(later.dialogue[0].start, 0)
        self.assertEqual(later.comments[0].id, before.comments[0].id)
        self.assertEqual(scene.comments[0].body, "Detached note")
        self.assertEqual(project.storyboard_value(later.id, column.id), "Chapter 2")
        self.assertEqual(later.metadata, before.metadata)
        self.assertEqual(scene.revisions[-1].text, before.text)
        self.assertEqual(scene.revisions[-1].dialogue, tuple(before.dialogue))
        joined = join_scenes(project, scene, later, "Joined", "Reviewed description", "")
        self.assertIs(joined, scene)
        self.assertEqual(scene.text, before.text)
        self.assertEqual(scene.dialogue[0], before.dialogue[0])
        self.assertTrue(later.historical)
        self.assertEqual(later.summary, "Continued description")
        self.assertEqual([event.kind for event in project.scene_changes], ["split", "join"])
        self.assertEqual(import_project(export_project(project)[1]), project)
        with TemporaryDirectory() as directory:
            path = Path(directory) / "recovery.zip"
            store = ProjectStore(project, path); store.commit()
            self.assertEqual(ProjectStore(persist_path=path).get(), project)

    def test_crossing_anchors_detach_and_do_not_guess_repeated_quotes(self):
        project, scene, _, speaker = sample()
        scene.dialogue = [DialogueAttribution(uuid4(), speaker.id, 2, 10, "“Hello.”", "“Hello.”")]
        scene.comments = [ManuscriptComment(uuid4(), 2, 10, "“Hello.”", "Note")]
        later = split_scene(project, scene, 5, "Continuation", "")
        self.assertTrue(scene.dialogue[0].detached)
        self.assertTrue(scene.comments[0].detached)
        self.assertEqual(later.dialogue, [])
        scene.text = "“Hello.” “Hello.”"
        update_dialogue_ranges(scene)
        self.assertTrue(scene.dialogue[0].detached)
        self.assertEqual(scene.dialogue[0].original_quote, "“Hello.”")

    def test_invalid_split_join_leave_project_unchanged(self):
        project, scene, later, _ = sample()
        original = deepcopy(project)
        for offset in [-1, 0, len(scene.text), True, 1.5]:
            with self.assertRaises(ValueError): split_scene(project, scene, offset, "New", "")
        project.scenes.append(Scene(uuid4(), "Third", text="Third"))
        original = deepcopy(project)
        for a, b, sep in [(scene, project.scenes[-1], ""), (later, scene, ""), (scene, later, "changed prose")]:
            with self.assertRaises(ValueError): join_scenes(project, a, b, "Joined", "", sep)
        self.assertEqual(project, original)

    def test_revisions_restore_attributions_but_not_metadata(self):
        _, scene, _, speaker = sample()
        scene.dialogue = [DialogueAttribution(uuid4(), speaker.id, 2, 10, "“Hello.”", "“Hello.”")]
        revision = scene.record_revision()
        scene.text = "Changed"
        scene.dialogue = [scene.dialogue[0].detach()]
        scene.metadata = SceneMetadata(tense="Present")
        scene.restore_revision(revision.id)
        self.assertEqual(scene.dialogue, list(revision.dialogue))
        self.assertEqual(scene.metadata.tense, "Present")

    def test_extraction_requires_occurrence_and_protects_confirmed_assignments(self):
        project, scene, _, speaker = sample()
        rows = [{"quote": "“Hello.”", "speaker_id": str(speaker.id)},
                {"quote": "“Hello.”", "occurrence": 2, "speaker_id": str(speaker.id)},
                {"quote": "Invented", "occurrence": 1}]
        result = parse_extraction(json.dumps({"dialogue": rows}), project, scene)
        self.assertEqual(len(result["rows"]), 1)
        row = result["rows"][0]
        self.assertEqual(row["start"], scene.text.rindex("“Hello.”"))
        scene.dialogue = [DialogueAttribution(uuid4(), speaker.id, row["start"], row["end"], row["quote"])]
        result = parse_extraction(json.dumps({"dialogue": rows}), project, scene)
        self.assertEqual(result["rows"], [])

    def test_evaluation_only_accepts_verified_exact_dialogue_sources(self):
        project, scene, later, speaker = sample()
        scene.dialogue = [DialogueAttribution(uuid4(), speaker.id, 2, 10, "“Hello.”", "“Hello.”")]
        rows = dialogue_rows(project, speaker.id)
        raw = {"observations": [{"dialogue_id": rows[0]["id"], "quote": "Hello", "explanation": "Specific voice observation"},
                                {"dialogue_id": rows[0]["id"], "quote": "Absent", "explanation": "Invented"}]}
        result = parse_evaluation(json.dumps(raw), rows)
        self.assertEqual(len(result), 1)
        self.assertEqual(scene.text[result[0]["start"]:result[0]["end"]], "Hello")
        scene.historical = True
        self.assertEqual(dialogue_rows(project, speaker.id), [])


class DialogueRoutesTests(TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        project, _, _, _ = sample()
        self.app = create_app(ProjectStore(project))
        self.app.config.update(TESTING=True, PROJECT_LIBRARY=ProjectLibrary(root), PROJECT_DRAFT_ROOT=root / "drafts")
        self.app.extensions["user_preferences"] = UserPreferences(root)
        self.app.extensions["text_analyses"] = UserTextAnalyses(root)
        self.app.extensions["ai_settings"] = UserAISettings(root)
        self.fake = Mock(standard_id="openai_compatible", display_name="fake", default_endpoint="")
        self.app.extensions["llm_registry"] = LLMRegistry([self.fake])
        self.app.extensions["ai_settings"].update_llm("local-user", {"endpoint": "http://127.0.0.1:8080/v1", "model": "local"}, self.app.extensions["llm_registry"])
        self.client = self.app.test_client(); self.client.get("/")
        self.store = next(iter(self.app.config["PROJECT_STORES"].values()))
        self.project = self.store.get(); self.scene, self.later = self.project.scenes
        self.speaker = self.project.wiki_pages[0]
        self.url = f"/scene/{self.scene.id}/dialogue"
        self.headers = {"X-Verwrity-Project-Id": str(self.project.project_id)}

    def data(self, **values):
        return {"source_hash": scene_source_hash(self.scene), "snapshot": fingerprint(self.project), **values}

    def assign(self, **values):
        return self.client.post(self.url, headers=self.headers, json=self.data(start=2, end=10, quote="“Hello.”", speaker_id=str(self.speaker.id), **values))

    def test_chooser_exposes_character_tags_without_changing_wiki_pages(self):
        self.project.wiki_pages.append(WikiPage(uuid4(), "Untagged notes", "Human knowledge"))
        before = deepcopy(self.project)
        response = self.client.get("/dialogue/characters")
        self.assertEqual(response.status_code, 200)
        pages = {page["title"]: page for page in response.json["pages"]}
        self.assertEqual(pages["Mara"]["tags"], ["character"])
        self.assertEqual(pages["Untagged notes"]["tags"], [])
        self.assertEqual(self.project, before)

    def test_manual_novelist_assignment_and_character_creation_preserve_wiki_and_prose(self):
        before = deepcopy(self.project)
        response = self.assign()
        self.assertEqual(response.status_code, 200, response.json)
        self.assertEqual(self.scene.text, before.scenes[0].text)
        self.assertEqual(self.project.wiki_pages, before.wiki_pages)
        self.assertFalse(self.project.features.fingal_mode)
        collection = self.client.get(f"/wiki/page/{self.speaker.id}/dialogue").json
        self.assertEqual(collection["rows"][0]["quote"], "“Hello.”")
        record = self.scene.dialogue[0]
        response = self.client.post(self.url, headers=self.headers, json=self.data(id=str(record.id), start=2, end=10, quote="“Hello.”", new_name="New person"))
        self.assertEqual(response.status_code, 200, response.json)
        self.assertEqual(self.project.wiki_pages[-1].body, "")
        self.assertIn("character", self.project.wiki_pages[-1].tags)
        self.assertEqual(self.scene.dialogue[0].id, record.id)
        self.assertEqual(len(response.json["created_pages"]), 1)
        self.assertEqual(self.client.post(f"/wiki/page/{self.speaker.id}/delete").status_code, 400)
        self.fake.complete.assert_not_called()

    def test_mapped_save_detach_undo_and_roundtrip(self):
        self.assign(); record = self.scene.dialogue[0]
        url = f"/scene/{self.scene.id}/text"
        changed = "Prefix " + self.scene.text
        response = self.client.post(url, data={"scene_text": changed, "scene_dialogue": json.dumps([
            {"id": str(record.id), "start": 9, "end": 17}])}, headers={**self.headers, "X-Verwrity-Scene-Hash": scene_source_hash(self.scene)})
        self.assertEqual(response.status_code, 204)
        self.assertFalse(self.scene.dialogue[0].detached)
        self.assertEqual(self.scene.dialogue[0].start, 9)
        self.client.post(url, data={"scene_text": "“Hello.”", "scene_dialogue": json.dumps([{"id": str(record.id), "detached": True}])})
        self.assertTrue(self.scene.dialogue[0].detached)
        # Another repeated quote cannot be claimed by offsets alone.
        self.client.post(url, data={"scene_text": "“Hello.”", "scene_dialogue": json.dumps([{"id": str(record.id), "start": 0, "end": 8}])})
        self.assertTrue(self.scene.dialogue[0].detached)
        self.client.post(url, data={"scene_text": changed, "scene_dialogue": json.dumps([{"id": str(record.id), "start": 9, "end": 17, "restored": True}])})
        self.assertFalse(self.scene.dialogue[0].detached)
        self.assertEqual(import_project(export_project(self.project)[1]), self.project)

    def test_failed_assignment_rolls_back_character_and_checkpoint(self):
        before = deepcopy(self.project)
        with patch.object(self.store, "commit", side_effect=OSError("disk failure")):
            response = self.assign(new_name="Unsaved character")
        self.assertEqual(response.status_code, 503)
        self.assertEqual(self.project, before)

    def test_extraction_releases_lock_signed_review_and_stale_rejection(self):
        acquired = []
        def complete(*args):
            def check():
                ok = PROJECT_LOCK.acquire(timeout=1); acquired.append(ok)
                if ok: PROJECT_LOCK.release()
            thread = threading.Thread(target=check); thread.start(); thread.join()
            return json.dumps({"dialogue": [{"quote": "“Hello.”", "occurrence": 2, "speaker_id": str(self.speaker.id), "uncertainty": "Inferred turn"}]})
        self.fake.complete.side_effect = complete
        before = deepcopy(self.project)
        response = self.client.post(self.url + "/extract", json=self.data(), headers=self.headers)
        self.assertEqual(response.status_code, 200, response.json)
        self.assertEqual(acquired, [True])
        self.assertEqual(self.project, before)
        review = response.json
        data = self.data(proposal=review["proposal"], choices=[{"index": 0, "speaker_id": str(self.speaker.id)}])
        self.scene.metadata = SceneMetadata(tense="Past")
        self.assertEqual(self.client.post(self.url + "/apply", json=data, headers=self.headers).status_code, 409)
        self.scene.metadata = SceneMetadata()
        response = self.client.post(self.url + "/apply", json=data, headers=self.headers)
        self.assertEqual(response.status_code, 200, response.json)
        self.assertEqual(self.scene.dialogue[0].origin, "ai-suggested-author-confirmed")
        self.assertEqual(self.scene.dialogue[0].start, self.scene.text.rindex("“Hello.”"))
        self.assertEqual(self.client.post(self.url + "/apply", json=data, headers=self.headers).status_code, 409)

    def test_remote_consent_and_safe_provider_errors(self):
        settings = self.app.extensions["ai_settings"]
        settings._save("local-user", "llm", {**settings.load("local-user")["llm"], "endpoint": "https://example.com/v1", "model": "remote", "remote_consent_endpoint": ""})
        self.assertEqual(self.client.post(self.url + "/extract", json=self.data(), headers=self.headers).status_code, 403)
        self.fake.complete.assert_not_called()
        settings.update_llm("local-user", {"endpoint": "http://127.0.0.1:8080/v1", "model": "local"}, self.app.extensions["llm_registry"])
        self.fake.complete.side_effect = RuntimeError("SECRET manuscript token")
        with self.assertLogs("verwrity", level="WARNING") as logs:
            response = self.client.post(self.url + "/extract", json=self.data(), headers=self.headers)
        self.assertEqual(response.status_code, 502)
        self.assertNotIn("SECRET", response.get_data(as_text=True) + str(logs.output))

    def test_evaluator_transient_exact_sources_and_rejects_changes_during_call(self):
        self.assertEqual(self.assign().status_code, 200)
        record = self.scene.dialogue[0]
        self.later.dialogue = [DialogueAttribution(uuid4(), self.speaker.id, None, None, "Missing", detached=True)]
        url = f"/wiki/page/{self.speaker.id}/dialogue/evaluate"
        snapshot = fingerprint(self.project)
        before = deepcopy(self.project)
        self.fake.complete.return_value = json.dumps({"observations": [
            {"dialogue_id": str(record.id), "quote": "Hello", "explanation": "A restrained greeting here."},
            {"dialogue_id": str(record.id), "quote": "Invented", "explanation": "Unsupported"}]})
        response = self.client.post(url, headers=self.headers, json={"snapshot": snapshot})
        self.assertEqual(response.status_code, 200, response.json)
        self.assertEqual(len(response.json["observations"]), 1)
        prompt = self.fake.complete.call_args.args[3]
        self.assertNotIn('"quote": "Missing"', prompt)
        self.assertEqual(self.project, before)
        def changing(*args):
            self.scene.metadata = SceneMetadata(voice_notes="Changed during evaluation")
            return json.dumps({"observations": []})
        self.fake.complete.side_effect = changing
        self.assertEqual(self.client.post(url, headers=self.headers, json={"snapshot": snapshot}).status_code, 409)

    def test_manual_confirmation_is_stale_safe_and_unknown_is_preserved(self):
        data = self.data(start=2, end=10, quote="“Hello.”", speaker_id=None)
        self.assertEqual(self.client.post(self.url, headers=self.headers, json=data).status_code, 200)
        self.assertIsNone(self.scene.dialogue[0].speaker_id)
        self.assertEqual(self.client.post(self.url, headers=self.headers, json=data).status_code, 409)
        self.assertEqual(len(self.scene.dialogue), 1)
        self.assertEqual(len(self.project.wiki_pages), 1)

    def test_plain_export_reordering_historical_scenes_and_no_source_loss(self):
        self.project.scenes.reverse()
        self.scene.historical = True
        response = self.client.post("/project/manuscript.txt", headers=self.headers, json={})
        self.assertEqual(response.status_code, 200)
        output = response.data.decode()
        self.assertIn("Scene 1: Second", output)
        self.assertIn(self.later.text, output)
        self.assertNotIn("First description", output)

    def test_structural_write_rollback_stale_order_and_join_separator(self):
        url = f"/scene/{self.scene.id}/structure"
        snapshot = self.client.get(url).json["snapshot"]
        data = {"snapshot": snapshot, "offset": 11, "title": "New part", "summary": "New description"}
        before = deepcopy(self.project)
        with patch.object(self.store, "commit", side_effect=OSError("disk")):
            response = self.client.post(url + "/split", json=data, headers=self.headers)
        self.assertEqual(response.status_code, 503)
        self.assertEqual(self.project, before)
        response = self.client.post(url + "/split", json=data, headers=self.headers)
        self.assertEqual(response.status_code, 200, response.json)
        self.assertEqual(self.client.post(url + "/split", json=data, headers=self.headers).status_code, 409)
        current = self.client.get(url).json
        response = self.client.post(url + "/join", headers=self.headers, json={"snapshot": current["snapshot"], "later_id": current["later"]["id"], "title": "Combined", "summary": "Reviewed", "separator": "\n\n"})
        self.assertEqual(response.status_code, 200, response.json)
        self.assertEqual(self.scene.text, before.scenes[0].text[:11] + "\n\n" + before.scenes[0].text[11:])

    def test_plain_export_current_order_unsaved_unicode_without_mutation(self):
        original = deepcopy(self.project); generation = self.store.generation
        text = 'Unsaved 😀\n\n“Écoute.”\n'
        response = self.client.post("/project/manuscript.txt", headers=self.headers,
            json={"scene_id": str(self.scene.id), "source_hash": scene_source_hash(self.scene), "text": text})
        self.assertEqual(response.status_code, 200)
        output = response.data.decode("utf-8")
        self.assertIn("Scene 1: First\nDescription: First description", output)
        self.assertIn(text, output)
        self.assertLess(output.index(text), output.index("Scene 2: Second"))
        self.assertEqual(self.project, original)
        self.assertEqual(self.store.generation, generation)
        self.assertIn("attachment", response.headers["Content-Disposition"])
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        self.scene.text = "Other tab"
        response = self.client.post("/project/manuscript.txt", headers=self.headers,
            json={"scene_id": str(self.scene.id), "source_hash": scene_source_hash(original.scenes[0]), "text": text})
        self.assertEqual(response.status_code, 409)
        self.assertEqual(self.scene.text, "Other tab")

    def test_plain_export_can_omit_scene_details_and_preserve_unsaved_prose(self):
        original = deepcopy(self.project); generation = self.store.generation
        text = 'Unsaved 😀\n\n“Écoute.”\n'
        response = self.client.post("/project/manuscript.txt", headers=self.headers,
            json={"scene_id": str(self.scene.id), "source_hash": scene_source_hash(self.scene), "text": text, "include_scene_details": False})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data.decode("utf-8"), text + "\n\n" + self.later.text)
        self.assertEqual(self.project, original)
        self.assertEqual(self.store.generation, generation)
        self.assertEqual(self.client.post("/project/manuscript.txt", headers=self.headers,
            json={"include_scene_details": "false"}).status_code, 400)

    def test_exact_source_navigation_rejects_stale_offsets_before_committing(self):
        generation = self.store.generation
        before = deepcopy(self.project)
        response = self.client.post(f"/scene/select/{self.later.id}", data={
            "evidence_hash": scene_source_hash(self.later), "ai_start": 0, "ai_end": 5, "ai_quote": "Wrong"})
        self.assertEqual(response.status_code, 409)
        self.assertEqual(self.store.generation, generation)
        self.assertEqual(self.project, before)
        with self.client.session_transaction() as session:
            self.assertEqual(session["active_scene_id"], str(self.scene.id))

    def test_tense_checker_shared_exact_evidence_and_no_prose_changes(self):
        self.fake.complete.return_value = json.dumps({"findings": [{"quote": "walks", "explanation": "Narration shifts from past without an apparent timeframe change", "severity": "concern"}]})
        before = deepcopy(self.project)
        response = self.client.post(f"/scene/{self.scene.id}/text-analysis/tense", json={"scene_text": 'She waited. He walks in. “I am here,” he said.'})
        self.assertEqual(response.status_code, 200, response.json)
        self.assertEqual(response.json["annotations"][0]["quote"], "walks")
        self.assertEqual(self.project, before)
        self.assertIn("flashbacks", TENSE_CHECKER.prompt)
