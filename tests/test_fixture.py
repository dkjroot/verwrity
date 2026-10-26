import tempfile
import unittest
from pathlib import Path

from verwrity.project.archive import import_project
from scripts.generate_fixture import DEFAULT_LIBRARY_ROOT, FixtureFormatError, generate_fixture, parse_fixture


class FixtureGeneratorTest(unittest.TestCase):
    def test_fixture_parses_scenes_wiki_tags_and_markdown_content(self) -> None:
        project = parse_fixture(
            """@project: Replay story

@scene: Opening
@summary: First beat.

# A heading in the scene
Scene text.

@wiki: Rowan
@tags: character, character, clue
@aliases: Ro, Rowan

Wiki body.
"""
        )

        self.assertEqual(project.title, "Replay story")
        self.assertEqual(project.scenes[0].title, "Opening")
        self.assertEqual(project.scenes[0].summary, "First beat.")
        self.assertIn("# A heading in the scene", project.scenes[0].text)
        self.assertEqual(project.wiki_pages[0].tags, ("character", "clue"))
        self.assertEqual(project.wiki_pages[0].aliases, ("Ro",))
        replay = parse_fixture(
            """@project: Replay story

@scene: Opening
@summary: First beat.

# A heading in the scene
Scene text.

@wiki: Rowan
@tags: character, character, clue

Wiki body.
"""
        )
        self.assertEqual(project.project_id, replay.project_id)
        self.assertEqual(project.scenes[0].id, replay.scenes[0].id)
        self.assertEqual(project.wiki_pages[0].id, replay.wiki_pages[0].id)

    def test_default_output_is_the_local_user_library(self) -> None:
        self.assertEqual(DEFAULT_LIBRARY_ROOT.name, "local-user")
        self.assertEqual(DEFAULT_LIBRARY_ROOT.parent.name, "user_files")

    def test_generated_archive_round_trips_through_canonical_archive_format(self) -> None:
        source = Path("fixtures/test-story.md")
        with tempfile.TemporaryDirectory() as directory:
            destination = generate_fixture(source, Path(directory) / "fixture.verwrity.zip")
            loaded = import_project(destination.read_bytes())

        self.assertEqual(loaded.title, "The Lantern Test Story")
        self.assertEqual(len(loaded.scenes), 8)
        self.assertTrue(all(len(scene.text.split()) >= 200 for scene in loaded.scenes))
        self.assertEqual(len(loaded.wiki_pages), 10)
        self.assertEqual([page.title for page in loaded.wiki_pages[:4]], ["Mara Vale", "Elias Wren", "Nadiya Bell", "Tom Arlen"])
        self.assertEqual([page.title for page in loaded.wiki_pages[4:6]], ["Greywater Ferry", "Lantern House"])
        self.assertEqual(loaded.wiki_pages[0].aliases, ("Mara", "Miss Vale", "Wave Strider"))
        self.assertIn("brass compass", loaded.scenes[0].text)

    def test_invalid_fixture_reports_a_useful_error(self) -> None:
        with self.assertRaisesRegex(FixtureFormatError, "@project"):
            parse_fixture("@scene: Missing project\n\nText")


if __name__ == "__main__":
    unittest.main()
