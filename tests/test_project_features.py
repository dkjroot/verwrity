"""Opt-in project capabilities never change authored content or leak projects."""

from copy import deepcopy
from dataclasses import replace
from io import BytesIO
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
from zipfile import ZipFile

from verwrity.domain.project_features import ProjectFeatures
from verwrity.domain.story import StoryProject
from verwrity.project.archive import export_project, import_project
from verwrity.project.drafts import DraftRepository
from verwrity.project.library import ProjectLibrary
from verwrity.project.preferences import UserPreferences
from verwrity.project.text_analysis import UserTextAnalyses
from verwrity.ai.settings import UserAISettings
from verwrity.project.store import ProjectStore
from verwrity.web.app import create_app


def rewrite_archive(data, features=None, version=5):
    output = BytesIO()
    with ZipFile(BytesIO(data)) as source, ZipFile(output, "w") as destination:
        for name in source.namelist():
            content = source.read(name)
            if name == "manifest.json":
                manifest = json.loads(content)
                manifest["archive_version"] = version
                content = json.dumps(manifest)
            if name == "project_features.json":
                if features is None:
                    continue
                content = json.dumps(features)
            destination.writestr(name, content)
    return output.getvalue()


class ProjectFeaturePersistenceTest(unittest.TestCase):
    def test_default_and_suite_preserve_individual_choices(self):
        self.assertEqual(StoryProject.demo().features, ProjectFeatures())
        features = ProjectFeatures(map_editor=True)
        self.assertTrue(features.map_enabled)
        self.assertFalse(features.characters_enabled)
        self.assertFalse(features.fingal_export_enabled)
        suite = replace(features, fingal_mode=True)
        self.assertTrue(suite.characters_enabled)
        self.assertTrue(suite.fingal_export_enabled)
        self.assertEqual(replace(suite, fingal_mode=False), features)

    def test_archive_library_duplicate_and_recovery_round_trips(self):
        project = StoryProject.demo()
        project.features = ProjectFeatures(True, False, True)
        data = export_project(project)[1]
        self.assertEqual(import_project(data), project)
        with ZipFile(BytesIO(data)) as source:
            self.assertEqual(json.loads(source.read("project_features.json")), project.features.as_dict())
        with TemporaryDirectory() as directory:
            root = Path(directory)
            library = ProjectLibrary(root)
            destination = library.save("author", project)
            self.assertEqual(library.load("author", destination.name), project)
            duplicate = library.load("author", library.duplicate("author", project, "Copy").name)
            self.assertNotEqual(duplicate.project_id, project.project_id)
            self.assertEqual(duplicate.features, project.features)
            drafts = DraftRepository(root / "drafts", "author")
            ProjectStore(project, drafts=drafts).commit()
            self.assertEqual(ProjectStore(deepcopy(project), drafts=drafts).get(), project)

    def test_versions_one_through_five_default_to_off(self):
        project = StoryProject.demo()
        project.features = ProjectFeatures(fingal_mode=True)
        for version in range(1, 6):
            with self.subTest(version=version):
                restored = import_project(rewrite_archive(export_project(project)[1], version=version))
                self.assertEqual(restored.features, ProjectFeatures())
                self.assertEqual(restored.manuscript, project.manuscript)

    def test_invalid_features_and_missing_v6_member_are_rejected(self):
        data = export_project(StoryProject.demo())[1]
        for value in [[], "bad", {"map_editor": 1}, {"fingal_mode": "false"},
                      {"character_editor": None}, {"unknown": True}]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                import_project(rewrite_archive(data, value))
        with self.assertRaises(ValueError):
            import_project(rewrite_archive(data, version=6))


class ProjectFeatureRoutesTest(unittest.TestCase):
    def setUp(self):
        self.directory = TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        root = Path(self.directory.name)
        self.app = create_app(ProjectStore(StoryProject.demo()))
        self.app.config.update(TESTING=True, PROJECT_DRAFT_ROOT=root / "drafts", PROJECT_LIBRARY=ProjectLibrary(root))
        self.app.extensions["user_preferences"] = UserPreferences(root)
        self.app.extensions["text_analyses"] = UserTextAnalyses(root)
        self.app.extensions["ai_settings"] = UserAISettings(root)
        self.client = self.app.test_client()
        self.client.get("/")
        self.store = next(iter(self.app.config["PROJECT_STORES"].values()))
        self.project = self.store.get()

    def save(self, features, expected=None, identity=None):
        return self.client.post("/project/features", json={"features": features,
            "expected_features": self.project.features.as_dict() if expected is None else expected},
            headers={"X-Verwrity-Project-Id": str(identity or self.project.project_id)})

    def test_saving_only_mutates_features_and_preserves_recovery(self):
        original = deepcopy(self.project)
        result = self.save({"fingal_mode": True})
        self.assertEqual(result.status_code, 200)
        self.assertTrue(result.json["changed"])
        self.assertEqual(replace(self.project, features=original.features), original)
        self.assertEqual(self.store.drafts.latest(self.project.project_id).project, self.project)
        generation = self.store.generation
        self.assertFalse(self.save(self.project.features.as_dict()).json["changed"])
        self.assertEqual(self.store.generation, generation)

    def test_invalid_stale_and_wrong_project_edits_preserve_settings(self):
        original = deepcopy(self.project)
        for value in [None, [], {"fingal_mode": 1}, {"unknown": True}]:
            self.assertEqual(self.save(value).status_code, 400)
        self.assertEqual(self.save({}, expected={"map_editor": True}).status_code, 409)
        self.assertEqual(self.save({}, identity="wrong-project").status_code, 409)
        self.assertEqual(self.project, original)
        self.assertEqual(self.client.post("/project/features", json={}).status_code, 409)

    def test_failed_commit_rolls_back_then_can_retry(self):
        generation = self.store.generation
        with patch.object(self.store, "commit", side_effect=OSError("private error")):
            response = self.save({"map_editor": True})
        self.assertEqual(response.status_code, 503)
        self.assertNotIn("private error", response.get_data(as_text=True))
        self.assertEqual(self.project.features, ProjectFeatures())
        self.assertEqual(self.store.generation, generation)
        self.assertEqual(self.save({"map_editor": True}).status_code, 200)

    def test_stale_other_session_is_rejected_and_new_projects_start_off(self):
        self.store.commit()
        other = self.app.test_client()
        with other.session_transaction() as state:
            state["project_id"] = str(self.project.project_id)
        other.get("/")
        self.save({"fingal_mode": True})
        response = other.post("/project/features", json={"features": {}, "expected_features": {}},
            headers={"X-Verwrity-Project-Id": str(self.project.project_id)})
        self.assertEqual(response.status_code, 409)
        self.client.post("/project/new")
        result = self.client.get("/project/features").json
        self.assertEqual(result["features"], ProjectFeatures().as_dict())
        self.assertNotEqual(result["project_id"], str(self.project.project_id))

    def test_named_open_restores_current_projects_choices(self):
        self.save({"character_editor": True})
        path = self.app.config["PROJECT_LIBRARY"].save("local-user", self.project)
        self.client.post("/project/new")
        self.client.post("/project/library-open", data={"project_filename": path.name})
        self.assertEqual(self.client.get("/project/features").json["features"], self.project.features.as_dict())


if __name__ == "__main__":
    unittest.main()
