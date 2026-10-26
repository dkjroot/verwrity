import unittest
import io
import zipfile
from uuid import uuid4

from verwrity.domain.story import ManuscriptComment, SceneRevision, StoryboardColumn, StoryProject, WikiRevision
from verwrity.project.archive import MAX_ARCHIVE_BYTES, MAX_MEMBER_BYTES, MAX_MEMBER_COUNT, export_project, import_project


class ArchiveTest(unittest.TestCase):
    def test_project_round_trip_preserves_source_content_and_title(self) -> None:
        original = StoryProject.demo()
        original.title = "A New Story"
        original.scenes[0].text = "Human-authored text.\nSecond paragraph."

        filename, data = export_project(original)
        loaded = import_project(data)

        self.assertEqual(filename, "A New Story.verwrity.zip")
        self.assertTrue(filename.endswith(".verwrity.zip"))
        self.assertEqual(loaded.title, original.title)
        self.assertIn("Human-authored text.", loaded.manuscript)
        self.assertIn("Write the discovery scene here.", loaded.manuscript)
        self.assertEqual([scene.id for scene in loaded.scenes], [scene.id for scene in original.scenes])

    def test_manuscript_is_derived_from_current_scenes(self) -> None:
        project = StoryProject.demo()
        project.scenes[0].text = "Canonical scene text."

        self.assertEqual(project.manuscript.splitlines()[0], "Canonical scene text.")

    def test_wiki_tags_and_revision_history_round_trip(self) -> None:
        project = StoryProject.demo()
        page = project.wiki_pages[0]
        revision = WikiRevision(uuid4(), page.title, "Earlier body", ("notes",), "2026-09-26T10:00:00+00:00", ("Old notes",))
        project.wiki_pages[0] = type(page)(page.id, page.title, "Current body", ("notes", "character"), (revision,), ("Notes", "Field notes"))

        loaded = import_project(export_project(project)[1])

        self.assertEqual(loaded.wiki_pages[0].tags, ("notes", "character"))
        self.assertEqual(loaded.wiki_pages[0].revisions, (revision,))
        self.assertEqual(loaded.wiki_pages[0].aliases, ("Notes", "Field notes"))
        self.assertEqual(loaded.wiki_pages[0].revisions[0].aliases, ("Old notes",))

    def test_storyboard_columns_and_cells_round_trip(self) -> None:
        project = StoryProject.demo()
        column = StoryboardColumn(uuid4(), "Alice and Bob")
        project.storyboard_columns.append(column)
        project.set_storyboard_value(project.scenes[0].id, column.id, "They agree to work together.")

        loaded = import_project(export_project(project)[1])

        self.assertEqual(loaded.storyboard_columns, [column])
        self.assertEqual(
            loaded.storyboard_value(loaded.scenes[0].id, column.id),
            "They agree to work together.",
        )

    def test_manuscript_comments_round_trip_without_entering_canonical_text(self) -> None:
        project = StoryProject.demo()
        scene = project.scenes[0]
        scene.text = "Mara found the silver key."
        comment = ManuscriptComment(uuid4(), 15, 25, "silver key", "Ask who left it.", True, True)
        scene.comments.append(comment)

        loaded = import_project(export_project(project)[1])

        self.assertEqual(loaded.scenes[0].comments, [comment])
        self.assertEqual(loaded.scenes[0].text, scene.text)
        self.assertEqual(loaded.manuscript.splitlines()[0], scene.text)

    def test_scene_revisions_round_trip_with_numbered_text_and_comments(self) -> None:
        project = StoryProject.demo()
        scene = project.scenes[0]
        scene.text = "Mara found the silver key."
        comment = ManuscriptComment(uuid4(), 0, 4, "Mara", "Keep this voice.")
        scene.comments.append(comment)
        revision = scene.record_revision()
        scene.text = "The key was on the table."

        loaded = import_project(export_project(project)[1])

        restored_scene = loaded.scene(scene.id)
        self.assertEqual(restored_scene.text, "The key was on the table.")
        self.assertEqual(restored_scene.revisions, [revision])
        self.assertEqual(restored_scene.revisions[0].comments[0].quote, comment.quote)
        self.assertEqual(restored_scene.revisions[0].comments[0].body, comment.body)
        self.assertIsInstance(restored_scene.revisions[0], SceneRevision)

    def test_archive_without_storyboard_data_remains_compatible(self) -> None:
        _, data = export_project(StoryProject.demo())
        old_archive = io.BytesIO()
        with zipfile.ZipFile(io.BytesIO(data)) as source, zipfile.ZipFile(old_archive, "w") as target:
            for item in source.infolist():
                if item.filename != "storyboard.json":
                    target.writestr(item, source.read(item.filename))

        loaded = import_project(old_archive.getvalue())

        self.assertEqual(loaded.storyboard_columns, [])
        self.assertEqual(loaded.storyboard_cells, {})

    def test_invalid_archive_shapes_are_rejected(self) -> None:
        with self.assertRaises(ValueError):
            import_project(b"not a zip")

        output = io.BytesIO()
        with zipfile.ZipFile(output, "w") as archive:
            archive.writestr("manifest.json", '{"archive_version": 999}')
            archive.writestr("manuscript.txt", "text")
        with self.assertRaises(ValueError):
            import_project(output.getvalue())

    def test_archive_import_enforces_container_size_limit(self) -> None:
        with self.assertRaisesRegex(ValueError, "too large"):
            import_project(b"x" * (MAX_ARCHIVE_BYTES + 1))

    def test_archive_import_enforces_member_count_and_expanded_size_limits(self) -> None:
        too_many = io.BytesIO()
        with zipfile.ZipFile(too_many, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("manifest.json", "{}")
            archive.writestr("manuscript.txt", "")
            for index in range(MAX_MEMBER_COUNT - 1):
                archive.writestr(f"extra-{index}.txt", "x")
        with self.assertRaises(ValueError):
            import_project(too_many.getvalue())

        oversized_member = io.BytesIO()
        with zipfile.ZipFile(oversized_member, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("manifest.json", "{}")
            archive.writestr("manuscript.txt", "")
            archive.writestr("large.txt", b"\0" * (MAX_MEMBER_BYTES + 1))
        with self.assertRaises(ValueError):
            import_project(oversized_member.getvalue())


if __name__ == "__main__":
    unittest.main()
