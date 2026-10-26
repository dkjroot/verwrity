import tempfile
import unittest
from pathlib import Path

from verwrity.domain.story import StoryProject
from verwrity.project.store import ProjectStore


class ProjectStoreTest(unittest.TestCase):
    def test_draft_store_recovers_canonical_scene_content(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "draft.verwrity.zip"
            original = StoryProject.demo()
            original.scenes[0].text = "Recovered draft"
            store = ProjectStore(original, path)
            store.commit()

            recovered = ProjectStore(StoryProject.demo(), path).get()

            self.assertEqual(recovered.scenes[0].text, "Recovered draft")
            self.assertEqual(recovered.manuscript.splitlines()[0], "Recovered draft")

    def test_corrupt_draft_falls_back_to_initial_project(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "draft.verwrity.zip"
            path.write_bytes(b"corrupt")
            initial = StoryProject.demo()

            recovered = ProjectStore(initial, path).get()

            self.assertIs(recovered, initial)


if __name__ == "__main__":
    unittest.main()
