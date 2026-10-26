"""Speed reader snapshots expose current prose without mutating the project."""
from copy import deepcopy
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from verwrity.domain.story import StoryProject
from verwrity.project.store import ProjectStore
from verwrity.web.app import create_app


class SpeedReaderTest(unittest.TestCase):
    def setUp(self):
        self.directory = TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        project = StoryProject.demo()
        project.scenes[0].text = "Current head."
        project.scenes[0].record_revision()
        project.scenes[0].text = "New current head."
        project.scenes[-1].historical = True
        self.app = create_app(ProjectStore(project))
        self.app.config["PROJECT_DRAFT_ROOT"] = Path(self.directory.name) / "drafts"
        self.client = self.app.test_client()
        # The endpoint itself selects the session's initial store, with no wiki
        # rendering, settings reads, or named library writes.
        self.project = project

    def test_only_current_prose_is_read_and_nothing_is_saved(self):
        before = deepcopy(self.project)
        response = self.client.get(f"/speed-reader/snapshot?project_id={self.project.project_id}")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        self.assertEqual(response.json, {
            "project_id": str(self.project.project_id),
            "scenes": [{"id": str(scene.id), "text": scene.text} for scene in self.project.current_scenes()],
        })
        stored = next(iter(self.app.config["PROJECT_STORES"].values())).get()
        self.assertEqual(stored, before)
        self.assertFalse((Path(self.directory.name) / "drafts").exists())

    def test_stale_project_and_oversized_manuscript_are_rejected(self):
        self.assertEqual(self.client.get("/speed-reader/snapshot?project_id=wrong").status_code, 409)
        store = next(iter(self.app.config["PROJECT_STORES"].values()))
        store.get().scenes[0].text = "x" * 5_000_001
        response = self.client.get(f"/speed-reader/snapshot?project_id={self.project.project_id}")
        self.assertEqual(response.status_code, 413)
        self.assertNotIn("scenes", response.json)
