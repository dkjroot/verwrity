"""Author context survives persistence and is separate from LLM source evidence."""

from copy import deepcopy
from dataclasses import replace
from io import BytesIO
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import Mock
from uuid import uuid4
from zipfile import ZipFile, ZIP_DEFLATED

from verwrity.ai.llm import LLMRegistry
from verwrity.ai.settings import UserAISettings
from verwrity.domain.scene_metadata import SceneMetadata
from verwrity.domain.story import StoryProject
from verwrity.project.archive import export_project, import_project
from verwrity.project.library import ProjectLibrary
from verwrity.project.store import ProjectStore
from verwrity.web.app import create_app


def archive_with_metadata(data, metadata):
    output = BytesIO()
    with ZipFile(BytesIO(data)) as source, ZipFile(output, "w", ZIP_DEFLATED) as destination:
        for name in source.namelist():
            content = source.read(name)
            if name == "scenes.json":
                scenes = json.loads(content)
                for scene in scenes:
                    if metadata is None:
                        scene.pop("metadata", None)
                    else:
                        scene["metadata"] = metadata
                content = json.dumps(scenes).encode()
            destination.writestr(name, content)
    return output.getvalue()


class SceneMetadataPersistenceTest(unittest.TestCase):
    def test_readable_archive_and_recovery_preserve_metadata_and_source(self):
        project = StoryProject.demo()
        scene = project.scenes[0]
        scene.metadata = SceneMetadata(location="Greywater 🕯️", time_period="2080",
            story_time="Before the voyage", pov_character="Mara", narrator="Older Mara",
            narrative_perspective="First person", tense="Past", voice_notes="Deliberately colloquial",
            purpose="Establish her unreliable account")
        scene.record_revision()
        scene.historical = True
        _, archive = export_project(project)
        self.assertEqual(import_project(archive), project)
        with ZipFile(BytesIO(archive)) as source:
            metadata = json.loads(source.read("scenes.json"))[0]["metadata"]
            self.assertEqual(metadata["provenance"], "human-authored")
            self.assertEqual(metadata["pov_character"], "Mara")
            self.assertNotIn("Deliberately colloquial", source.read("manuscript.txt").decode())
        with TemporaryDirectory() as directory:
            path = Path(directory) / "draft.verwrity.zip"
            store = ProjectStore(project, path)
            store.commit()
            recovered = ProjectStore(persist_path=path)
            self.assertTrue(recovered.recovered_from_disk)
            self.assertEqual(recovered.get(), project)

    def test_older_archives_default_to_empty_metadata(self):
        project = StoryProject.demo()
        archive = archive_with_metadata(export_project(project)[1], None)
        self.assertEqual(import_project(archive), project)

    def test_invalid_imported_metadata_is_rejected(self):
        archive = export_project(StoryProject.demo())[1]
        for value in [[], "bad", {"location": None}, {"location": "x" * 501},
                      {"voice_notes": "x" * 2001}, {"provenance": "ai-derived"}, {"unknown": "value"}]:
            with self.subTest(value_type=type(value)):
                with self.assertRaises(ValueError):
                    import_project(archive_with_metadata(archive, value))

    def test_copying_prose_revision_does_not_restore_old_scene_intent(self):
        scene = StoryProject.demo().scenes[0]
        old = scene.record_revision()
        scene.text = "New prose"
        scene.metadata = SceneMetadata(narrator="Omniscient narrator")
        scene.restore_revision(old.id)
        self.assertEqual(scene.metadata.narrator, "Omniscient narrator")


class SceneMetadataRoutesTest(unittest.TestCase):
    def setUp(self):
        self.directory = TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        root = Path(self.directory.name)
        self.app = create_app(ProjectStore(StoryProject.demo()))
        self.app.config.update(TESTING=True, PROJECT_DRAFT_ROOT=root / ".drafts", PROJECT_LIBRARY=ProjectLibrary(root))
        self.app.extensions["ai_settings"] = UserAISettings(root)
        self.fake = Mock(standard_id="openai_compatible", display_name="fake", default_endpoint="")
        self.app.extensions["llm_registry"] = LLMRegistry([self.fake])
        self.app.extensions["ai_settings"].update_llm("local-user", {
            "endpoint": "http://127.0.0.1:8080/v1", "model": "local",
        }, self.app.extensions["llm_registry"])
        self.client = self.app.test_client()
        self.client.get("/")
        self.store = next(iter(self.app.config["PROJECT_STORES"].values()))
        self.project = self.store.get()
        self.scene = self.project.scenes[0]
        self.url = f"/scene/{self.scene.id}/metadata"

    def test_metadata_edit_preserves_all_prose_identity_and_recovery(self):
        self.scene.record_revision()
        original = deepcopy(self.scene)
        response = self.client.post(self.url, json={"pov_character": " Mara ", "voice_notes": "Colloquial\r\nvoice",
                                                  "narrative_perspective": "Not applicable"})
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json["changed"])
        self.assertEqual(response.json["metadata"]["voice_notes"], "Colloquial\nvoice")
        self.assertEqual(replace(self.scene, metadata=original.metadata), original)
        self.assertEqual(self.client.get(self.url).json["metadata"]["pov_character"], "Mara")
        self.assertEqual(import_project(export_project(self.project)[1]), self.project)
        with self.client.session_transaction() as session:
            path = (Path(self.app.config["PROJECT_DRAFT_ROOT"]) / "local-user" / "drafts"
                    / str(self.project.project_id) / "current.verwrity.zip")
        self.assertEqual(ProjectStore(persist_path=path).get(), self.project)
        self.fake.complete.assert_not_called()

    def test_invalid_edits_and_historical_scenes_do_not_mutate_project(self):
        original = deepcopy(self.project)
        for value in [None, [], {"location": 3}, {"tense": "x" * 501}, {"provenance": "ai-derived"}]:
            self.assertEqual(self.client.post(self.url, json=value).status_code, 400)
        self.assertEqual(self.project, original)
        for identity in ["bad", str(uuid4())]:
            self.assertEqual(self.client.get(f"/scene/{identity}/metadata").status_code, 404)
        self.scene.historical = True
        self.assertEqual(self.client.post(self.url, json={"location": "Elsewhere"}).status_code, 404)
        self.assertEqual(self.scene.metadata, original.scenes[0].metadata)

    def test_card_edits_title_and_description_without_changing_prose_or_scene_identity(self):
        original = deepcopy(self.scene)
        response = self.client.post(self.url, json={"metadata": {"location": "Greywater"},
            "title": " Renamed scene ", "summary": "New description\r\nSecond line"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.scene.title, "Renamed scene")
        self.assertEqual(self.scene.summary, "New description\nSecond line")
        self.assertEqual(self.scene.id, original.id)
        self.assertEqual(self.scene.text, original.text)
        html = self.client.get("/").get_data(as_text=True)
        self.assertIn('title="New description\nSecond line">Renamed scene</button>', html)
        for view in ["notes", "grid"]:
            self.assertIn("Renamed scene", self.client.get(f"/storyboard?view={view}").get_data(as_text=True))
        saved = deepcopy(self.project)
        for title, summary in [("", "x"), (1, "x"), ("x" * 501, "x"), ("x", None), ("x", "x" * 5001)]:
            self.assertEqual(self.client.post(self.url, json={"metadata": {}, "title": title, "summary": summary}).status_code, 400)
        self.assertEqual(self.project, saved)

    def test_scene_movement_preserves_author_context_by_stable_identity(self):
        self.scene.metadata = SceneMetadata(pov_character="Mara")
        identity = self.scene.id
        self.client.post(f"/scene/{identity}/move", data={"direction": "down"})
        self.assertEqual(self.project.current_scenes()[1].id, identity)
        self.assertEqual(self.project.scene(identity).metadata.pov_character, "Mara")

    def test_scene_analysis_receives_intent_but_cannot_cite_it_as_prose(self):
        self.scene.metadata = SceneMetadata(pov_character="Narrator-only-name", voice_notes="Intent-only-quote")
        original = deepcopy(self.project)
        self.fake.complete.return_value = json.dumps({"findings": [
            {"quote": "snapshot", "explanation": "Actual source"},
            {"quote": "Intent-only-quote", "explanation": "Metadata is not prose"},
        ]})
        url = f"/scene/{self.scene.id}/text-analysis/cliche"
        result = self.client.post(url, json={"scene_text": "Unsaved snapshot"})
        self.assertEqual(result.status_code, 200)
        self.assertEqual([item["quote"] for item in result.json["annotations"]], ["snapshot"])
        prompt = self.fake.complete.call_args.args[3]
        self.assertIn("Narrator-only-name", prompt)
        self.assertIn("Intent-only-quote", prompt)
        self.assertIn(self.scene.summary, prompt)
        self.assertNotIn(self.project.scenes[1].text, prompt)
        self.assertEqual(self.project, original)
        first_hash = result.json["context_hash"]
        self.scene.metadata = replace(self.scene.metadata, narrator="Different narrator")
        second = self.client.post(url, json={"scene_text": "Unsaved snapshot"}).json
        self.assertNotEqual(second["context_hash"], first_hash)
        self.assertEqual(second["source_hash"], result.json["source_hash"])

    def test_qa_and_manuscript_tasks_receive_each_scene_metadata_without_new_evidence_sources(self):
        self.scene.metadata = SceneMetadata(voice_notes="First-intent-only")
        self.project.scenes[1].metadata = SceneMetadata(voice_notes="Second-intent-only")
        self.fake.complete.return_value = json.dumps({"answer": "A report", "evidence": [
            {"source_type": "scene", "source_id": str(self.scene.id), "quote": "First-intent-only"},
            {"source_type": "scene", "source_id": str(self.scene.id), "quote": self.scene.text},
        ]})
        for data in [{"question": "Check voices"}, {"task_id": "narrative_voice"}]:
            response = self.client.post("/ai/ask", json=data)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(len(response.json["evidence"]), 1)
            prompt = self.fake.complete.call_args.args[3]
            self.assertIn("First-intent-only", prompt)
            self.assertIn("Second-intent-only", prompt)
