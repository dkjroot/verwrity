import tempfile
import unittest
from pathlib import Path

from verwrity.domain.story import StoryProject
from verwrity.project.library import ProjectLibrary


class LibraryTest(unittest.TestCase):
    def test_projects_are_isolated_by_user(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            library = ProjectLibrary(Path(directory))
            project = StoryProject.demo()
            project.title = "Private story"
            library.save("alice", project)

            filename = library.list("alice")[0]
            self.assertEqual(filename, "Private story.verwrity.zip")
            self.assertEqual(library.list("bob"), [])
            self.assertEqual(library.load("alice", filename).title, "Private story")

    def test_different_projects_with_same_title_get_one_up_names(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            library = ProjectLibrary(Path(directory))
            first = StoryProject.demo()
            second = StoryProject.demo()
            library.save("alice", first)
            library.save("alice", second)
            self.assertEqual(library.list("alice"), ["Untitled story (2).verwrity.zip", "Untitled story.verwrity.zip"])

    def test_duplicate_has_independent_scene_objects(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            library = ProjectLibrary(Path(directory))
            original = StoryProject.demo()
            library.duplicate("alice", original, "Copy")

            copied = library.load("alice", "Copy.verwrity.zip")
            copied.scenes[0].text = "Changed copy"

            self.assertNotEqual(copied.scenes[0].text, original.scenes[0].text)

    def test_unrecognized_archives_are_ignored_rejected_and_preserved(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            library = ProjectLibrary(Path(directory))
            project = StoryProject.demo()
            saved = library.save("alice", project)
            unknown = saved.with_name("Untitled story.old.zip")
            saved.replace(unknown)
            original = unknown.read_bytes()

            self.assertEqual(library.list("alice"), [])
            with self.assertRaises(ValueError):
                library.load("alice", unknown.name)
            with self.assertRaises(ValueError):
                library.delete("alice", unknown.name)
            current = library.save("alice", project)
            self.assertEqual(library.list("alice"), [current.name])
            self.assertEqual(unknown.read_bytes(), original)

    def test_invalid_user_and_filename_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            library = ProjectLibrary(Path(directory))
            with self.assertRaises(ValueError):
                library.list("../outside")
            with self.assertRaises(ValueError):
                library.load("alice", "../outside.verwrity.zip")


if __name__ == "__main__":
    unittest.main()
