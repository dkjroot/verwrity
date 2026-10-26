"""Regression coverage for identity, recovery, validation, and author notes."""

from copy import deepcopy
from io import BytesIO
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Event, Thread
from unittest import TestCase
from unittest.mock import patch
from uuid import uuid4
import zipfile

from verwrity.domain.story import ManuscriptComment, StoryboardColumn, StoryProject
from verwrity.project.archive import export_project, import_project
from verwrity.project.drafts import DraftConflict, DraftRepository
from verwrity.project.library import ProjectLibrary
from verwrity.project.store import ProjectStore
from verwrity.web.app import create_app
from verwrity.web.routes.scenes import _replace_head_text
from verwrity.web.services.workspace import scene_source_hash


def modified_archive(member, value):
    source = export_project(StoryProject.demo())[1]
    output = BytesIO()
    with zipfile.ZipFile(BytesIO(source)) as archive, zipfile.ZipFile(output, "w") as target:
        for name in archive.namelist():
            target.writestr(name, json.dumps(value) if name == member else archive.read(name))
    return output.getvalue()


class StorageSafetyTest(TestCase):
    def test_duplicate_preserves_every_project_field_and_is_independent(self):
        project = StoryProject.demo()
        project.storyboard_columns = [StoryboardColumn(uuid4(), "Purpose")]
        project.set_storyboard_value(project.scenes[0].id, project.storyboard_columns[0].id, "Introduce a clue")
        project.spelling_dictionary = {"verwrity"}
        project.scenes[0].record_revision()
        with TemporaryDirectory() as directory:
            library = ProjectLibrary(directory)
            path = library.duplicate("alice", project, "Copy")
            copied = library.load("alice", path.name)
            expected = deepcopy(project)
            expected.title, expected.project_id = "Copy", copied.project_id
            self.assertNotEqual(copied.project_id, project.project_id)
            self.assertEqual(copied, expected)
            copied.storyboard_columns[0].title = "Changed"
            copied.spelling_dictionary.clear()
            self.assertEqual(project.storyboard_columns[0].title, "Purpose")
            self.assertEqual(project.spelling_dictionary, {"verwrity"})

    def test_rename_preserves_identity_without_duplicate_library_entries(self):
        with TemporaryDirectory() as directory:
            library = ProjectLibrary(directory)
            project = StoryProject.demo()
            old = library.save("alice", project)
            unrelated = StoryProject("Renamed")
            library.save("alice", unrelated)
            project.title = "Renamed"
            current = library.save("alice", project)
            self.assertFalse(old.exists())
            self.assertEqual(current.name, "Renamed (2).verwrity.zip")
            self.assertEqual(library.load("alice", current.name), project)
            self.assertEqual(library.load("alice", "Renamed.verwrity.zip"), unrelated)
            self.assertEqual(library.save("alice", project), current)

    def test_named_saves_with_periods_in_the_title_are_loadable(self):
        with TemporaryDirectory() as directory:
            library = ProjectLibrary(directory)
            project = StoryProject("Draft 1.2")
            path = library.save("alice", project)
            self.assertEqual(library.load("alice", path.name), project)

    def test_failed_rename_keeps_previous_archive_and_cleans_temporary_file(self):
        with TemporaryDirectory() as directory:
            library = ProjectLibrary(directory)
            project = StoryProject.demo()
            original = library.save("alice", project)
            data = original.read_bytes()
            project.title = "New name"
            with patch.object(Path, "replace", side_effect=OSError("disk failure")):
                with self.assertRaises(OSError):
                    library.save("alice", project)
            self.assertEqual(original.read_bytes(), data)
            self.assertEqual(list(original.parent.glob(".saving-*")), [])

    def test_legacy_duplicate_identity_lookup_chooses_newest(self):
        with TemporaryDirectory() as directory:
            library = ProjectLibrary(directory)
            project = StoryProject.demo()
            old = library.save("alice", project)
            project.title = "Zulu"
            _, data = export_project(project)
            current = old.parent / "Zulu.verwrity.zip"
            current.write_bytes(data)
            os.utime(old, ns=(1, 1))
            self.assertEqual(library.find_project_id("alice", project.project_id), (current.name, project))

    def test_export_limits_preserve_existing_named_save_and_draft(self):
        with TemporaryDirectory() as directory:
            library = ProjectLibrary(directory)
            project = StoryProject.demo()
            saved = library.save("alice", project)
            store = ProjectStore(project, Path(directory) / "draft.verwrity.zip")
            store.commit()
            named_before, draft_before = saved.read_bytes(), store._persist_path.read_bytes()
            project.scenes[0].text = "large" * 1000
            with patch("verwrity.project.archive.MAX_MEMBER_BYTES", 1000):
                with self.assertRaises(ValueError):
                    library.save("alice", project)
                with self.assertRaises(ValueError):
                    store.commit()
            self.assertEqual(saved.read_bytes(), named_before)
            self.assertEqual(store._persist_path.read_bytes(), draft_before)

    def test_export_checks_compressed_and_total_expanded_limits(self):
        for constant in ("MAX_ARCHIVE_BYTES", "MAX_EXPANDED_BYTES"):
            with self.subTest(constant=constant), patch("verwrity.project.archive." + constant, 100):
                with self.assertRaises(ValueError):
                    export_project(StoryProject.demo())

    def test_malformed_nested_structures_are_controlled_rejections(self):
        for member, value in [
            ("manifest.json", None), ("manifest.json", []),
            ("scenes.json", [None]), ("wiki.json", [None]),
            ("storyboard.json", {"columns": [None]}),
            ("storyboard.json", {"cells": [None]}),
            ("scenes.json", [{"id": str(uuid4()), "text": []}]),
            ("wiki.json", [{"id": str(uuid4()), "tags": "character"}]),
            ("wiki.json", [{"id": str(uuid4()), "revisions": [None]}]),
        ]:
            with self.subTest(member=member, value=value), self.assertRaises(ValueError):
                import_project(modified_archive(member, value))

    def test_duplicate_ids_and_archive_members_are_rejected(self):
        for member in ("scenes.json", "wiki.json"):
            with zipfile.ZipFile(BytesIO(export_project(StoryProject.demo())[1])) as archive:
                value = json.loads(archive.read(member))
            with self.subTest(member=member), self.assertRaises(ValueError):
                import_project(modified_archive(member, [value[0], value[0]]))
        output = BytesIO()
        with zipfile.ZipFile(BytesIO(export_project(StoryProject.demo())[1])) as archive, zipfile.ZipFile(output, "w") as target:
            for record in archive.infolist():
                target.writestr(record, archive.read(record.filename))
            import warnings
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", UserWarning)
                target.writestr("manifest.json", archive.read("manifest.json"))
        with self.assertRaises(ValueError):
            import_project(output.getvalue())

    def test_duplicate_nested_ids_are_rejected(self):
        project = StoryProject.demo()
        revision = project.scenes[0].record_revision()
        project.scenes[0].revisions.append(revision)
        with self.assertRaises(ValueError):
            export_project(project)
        project.scenes[0].revisions.clear()
        scene = project.scenes[0]
        scene.comments = [ManuscriptComment(uuid4(), 0, 5, "Write", "Note")]
        scene.comments.append(deepcopy(scene.comments[0]))
        with self.assertRaises(ValueError):
            export_project(project)

    def test_empty_scene_collection_does_not_import_generated_text_as_a_scene(self):
        project = StoryProject("Empty")
        self.assertEqual(import_project(export_project(project)[1]), project)

    def test_version_one_archives_remain_readable_and_new_saves_are_version_four(self):
        project = StoryProject.demo()
        output = BytesIO()
        with zipfile.ZipFile(BytesIO(export_project(project)[1])) as archive, zipfile.ZipFile(output, "w") as target:
            for name in archive.namelist():
                data = archive.read(name)
                if name == "manifest.json":
                    manifest = json.loads(data)
                    self.assertEqual(manifest["archive_version"], 10)
                    manifest["archive_version"] = 1
                    data = json.dumps(manifest)
                target.writestr(name, data)
        self.assertEqual(import_project(output.getvalue()), project)

    def test_detached_comments_survive_roundtrip_and_prose_checkpoints(self):
        project = StoryProject.demo()
        scene = project.scenes[0]
        scene.text = "Alpha target omega"
        comment = ManuscriptComment(uuid4(), 6, 12, "target", "Keep this note", prefix="Alpha ", suffix=" omega")
        scene.comments.append(comment)
        _replace_head_text(scene, "target", "", True)
        self.assertTrue(comment.detached)
        self.assertEqual(comment.original_quote, "target")
        revision = scene.record_revision()
        loaded = import_project(export_project(project)[1])
        self.assertEqual(loaded, project)
        self.assertEqual(loaded.scenes[0].revisions[0], revision)
        self.assertEqual(loaded.scenes[0].comments[0].body, "Keep this note")

    def test_legacy_stale_comment_is_preserved_without_guessing_repeated_quote(self):
        identity = uuid4()
        data = [{"id": str(uuid4()), "title": "Scene", "text": "target target",
                 "comments": [{"id": str(identity), "start": 99, "end": 105, "quote": "target", "body": "Note"}]}]
        project = import_project(modified_archive("scenes.json", data))
        comment = project.scenes[0].comments[0]
        self.assertEqual(comment.id, identity)
        self.assertTrue(comment.detached)
        self.assertIsNone(comment.start)
        self.assertEqual(comment.original_quote, "target")


class DraftRepositoryTest(TestCase):
    def test_unrecognized_recovery_names_are_ignored_and_preserved(self):
        with TemporaryDirectory() as directory:
            repository = DraftRepository(Path(directory), "alice")
            project = StoryProject.demo()
            project_directory = repository.directory(project.project_id)
            project_directory.mkdir(parents=True)
            unknown = project_directory / "current.old.zip"
            original = export_project(project)[1]
            unknown.write_bytes(original)

            self.assertIsNone(repository.latest(project.project_id))
            self.assertIsNone(repository.generation(project.project_id))
            repository.save(project, None)
            self.assertEqual(repository.latest(project.project_id).project, project)
            repository.discard(project.project_id)
            self.assertEqual(unknown.read_bytes(), original)

    def test_retention_and_user_project_isolation(self):
        with TemporaryDirectory() as directory:
            repository = DraftRepository(Path(directory), "alice")
            project, other = StoryProject.demo(), StoryProject("Other")
            other_repository = DraftRepository(Path(directory), "bob")
            other_repository.save(other, None)
            generation = None
            for number in range(7):
                project.scenes[0].text = str(number)
                generation = repository.save(project, generation)
            files = list(repository.directory(project.project_id).glob("*.verwrity.zip"))
            self.assertEqual(len(files), 3)
            self.assertEqual([import_project((repository.directory(project.project_id) / name).read_bytes()).scenes[0].text
                              for name in repository.NAMES], ["6", "5", "4"])
            self.assertEqual([item.project.project_id for item in repository.list()], [project.project_id])
            self.assertEqual(other_repository.latest(other.project_id).project, other)

    def test_recovery_falls_back_within_selected_project_and_preserves_corrupt_file(self):
        with TemporaryDirectory() as directory:
            repository = DraftRepository(Path(directory), "alice")
            project = StoryProject.demo()
            generation = repository.save(project, None)
            baseline = deepcopy(project)
            project.scenes[0].text = "Second"
            repository.save(project, generation)
            current = repository.directory(project.project_id) / repository.NAMES[0]
            current.write_bytes(b"corrupt")
            self.assertEqual(repository.latest(project.project_id).project, baseline)
            self.assertEqual(current.read_bytes(), b"corrupt")
            self.assertIsNone(repository.latest(uuid4()))

    def test_stale_session_cannot_overwrite_another_sessions_project(self):
        with TemporaryDirectory() as directory:
            repository = DraftRepository(Path(directory), "alice")
            original = StoryProject.demo()
            repository.save(original, None)
            first = ProjectStore(deepcopy(original), drafts=repository)
            second = ProjectStore(deepcopy(original), drafts=repository)
            first.get().scenes[0].text = "First session"
            first.commit()
            second.get().scenes[1].text = "Stale session"
            with self.assertRaises(DraftConflict):
                second.commit()
            self.assertEqual(repository.latest(original.project_id).project, first.get())

    def test_legacy_migration_retains_latest_three_and_leaves_corrupt_sources(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            legacy = root / ".drafts"
            legacy.mkdir()
            project = StoryProject.demo()
            for number in range(6):
                project.scenes[0].text = str(number)
                path = legacy / f"session-{number}.verwrity.zip"
                path.write_bytes(export_project(project)[1])
                modified = (number + 1) * 1_000_000_000
                os.utime(path, ns=(modified, modified))
            corrupt = legacy / "corrupt.verwrity.zip"
            corrupt.write_bytes(b"broken")
            repository = DraftRepository(root, "local-user")
            repository.migrate_legacy(legacy)
            self.assertEqual(list(legacy.glob("*.verwrity.zip")), [corrupt])
            self.assertEqual([import_project((repository.directory(project.project_id) / name).read_bytes()).scenes[0].text
                              for name in repository.NAMES], ["5", "4", "3"])
            repository.migrate_legacy(legacy)
            self.assertEqual(repository.latest(project.project_id).project.scenes[0].text, "5")

    def test_legacy_session_resolution_is_bounded_to_a_uuid_filename(self):
        with TemporaryDirectory() as directory:
            legacy = Path(directory)
            session_id = uuid4().hex
            project = StoryProject.demo()
            (legacy / f"{session_id}.verwrity.zip").write_bytes(export_project(project)[1])
            self.assertEqual(DraftRepository.legacy_project_id(legacy, session_id), project.project_id)
            self.assertIsNone(DraftRepository.legacy_project_id(legacy, "../outside"))

    def test_failed_migration_keeps_legacy_sources_until_all_selected_snapshots_are_verified(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            legacy = root / ".drafts"
            legacy.mkdir()
            project = StoryProject.demo()
            originals = {}
            for number in range(4):
                project.scenes[0].text = str(number)
                path = legacy / f"session-{number}.verwrity.zip"
                originals[path] = export_project(project)[1]
                path.write_bytes(originals[path])
                modified = (number + 1) * 1_000_000_000
                os.utime(path, ns=(modified, modified))
            repository = DraftRepository(root, "local-user")
            from verwrity.project.files import atomic_write

            def fail_current(path, data):
                if path.name == "current.verwrity.zip":
                    raise OSError("disk full")
                atomic_write(path, data)

            with patch("verwrity.project.drafts.atomic_write", side_effect=fail_current):
                with self.assertRaises(OSError):
                    repository.migrate_legacy(legacy)
            self.assertEqual({path: path.read_bytes() for path in legacy.glob("*.verwrity.zip")}, originals)
            repository.migrate_legacy(legacy)
            self.assertEqual(repository.latest(project.project_id).project.scenes[0].text, "3")
            self.assertEqual(list(legacy.glob("*.verwrity.zip")), [])

    def test_failed_rotation_preserves_current_snapshot_and_stale_generation(self):
        with TemporaryDirectory() as directory:
            repository = DraftRepository(Path(directory), "alice")
            project = StoryProject.demo()
            generation = repository.save(project, None)
            project.scenes[0].text = "Second"
            generation = repository.save(project, generation)
            baseline = deepcopy(project)
            project.scenes[0].text = "Third"
            with patch("verwrity.project.drafts.atomic_write", side_effect=OSError("disk full")):
                with self.assertRaises(OSError):
                    repository.save(project, generation)
            self.assertEqual(repository.generation(project.project_id), generation)
            self.assertEqual(repository.latest(project.project_id).project, baseline)

    def test_overlapping_commits_serialize_instead_of_publishing_old_data_last(self):
        with TemporaryDirectory() as directory:
            project = StoryProject.demo()
            project.scenes[0].text = "Old"
            store = ProjectStore(project, Path(directory) / "draft.verwrity.zip")
            entered, release, done = Event(), Event(), Event()
            errors = []
            original_export = export_project

            def slow_export(value):
                if value.scenes[0].text == "Old":
                    entered.set()
                    if not release.wait(5):
                        raise RuntimeError("Test coordination timed out")
                return original_export(value)

            def commit():
                try:
                    store.commit()
                except Exception as error:
                    errors.append(error)
                finally:
                    done.set()

            with patch("verwrity.project.store.export_project", side_effect=slow_export):
                first = Thread(target=commit)
                first.start()
                self.assertTrue(entered.wait(5))
                project.scenes[0].text = "New"
                second = Thread(target=store.commit)
                second.start()
                release.set()
                first.join(5)
                second.join(5)
            self.assertFalse(first.is_alive() or second.is_alive())
            self.assertEqual(errors, [])
            self.assertEqual(import_project(store._persist_path.read_bytes()).scenes[0].text, "New")


class StorageRoutesTest(TestCase):
    def setUp(self):
        self.directory = TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.project = StoryProject.demo()
        self.app = create_app(ProjectStore(self.project))
        self.app.config.update(TESTING=True, PROJECT_LIBRARY=ProjectLibrary(self.root), PROJECT_DRAFT_ROOT=self.root)
        self.client = self.app.test_client()
        self.client.get("/")
        self.store = next(iter(self.app.config["PROJECT_STORES"].values()))
        self.scene = self.store.get().scenes[0]

    def tearDown(self):
        self.directory.cleanup()

    def test_old_tab_source_hash_is_rejected_without_mutating_latest_prose(self):
        old_hash = scene_source_hash(self.scene)
        first = self.client.post(f"/scene/{self.scene.id}/text", data={"scene_text": "New"}, headers={"X-Verwrity-Scene-Hash": old_hash})
        self.assertEqual(first.status_code, 204)
        stale = self.client.post(f"/scene/{self.scene.id}/text", data={"scene_text": "Old tab"}, headers={"X-Verwrity-Scene-Hash": old_hash})
        self.assertEqual(stale.status_code, 409)
        self.assertEqual(self.store.get().scenes[0].text, "New")
        self.assertEqual(first.headers["X-Verwrity-Scene-Hash"], scene_source_hash(self.scene))

    def test_help_does_not_initialize_or_migrate_project_storage(self):
        fresh = self.app.test_client()
        with patch("verwrity.web.services.persistence.active_store") as store:
            response = fresh.get("/help")
        self.assertEqual(response.status_code, 200)
        store.assert_not_called()

    def test_size_failure_rolls_back_memory_and_preserves_disk(self):
        self.store.commit()
        before = deepcopy(self.store.get())
        current = self.store.drafts.directory(before.project_id) / "current.verwrity.zip"
        data = current.read_bytes()
        with patch("verwrity.project.archive.MAX_MEMBER_BYTES", 1000):
            response = self.client.post(f"/scene/{self.scene.id}/text", data={"scene_text": "large" * 1000})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.store.get(), before)
        self.assertEqual(current.read_bytes(), data)
        self.assertEqual(self.scene.text, before.scenes[0].text, "Rollback preserves the live scene object")

    def test_deleted_passage_comment_can_be_reviewed_and_explicitly_reattached(self):
        self.scene.text = "target target"
        response = self.client.post(f"/scene/{self.scene.id}/comments", json={"start": 0, "end": 6, "quote": "target", "body": "Note"})
        identity = response.json["comment"]["id"]
        detached = self.client.post(f"/scene/{self.scene.id}/text", data={"scene_text": "target",
            "scene_comments": json.dumps([{"id": identity, "start": None, "end": None, "detached": True}])})
        self.assertEqual(detached.status_code, 204)
        self.assertTrue(self.scene.comments[0].detached)
        self.assertIn(b"Review comments", self.client.get("/").data)
        # Autosave is not authority to reattach a detached note.
        self.client.post(f"/scene/{self.scene.id}/text", data={"scene_text": "target",
            "scene_comments": json.dumps([{"id": identity, "start": 0, "end": 6}])})
        self.assertTrue(self.scene.comments[0].detached)
        response = self.client.post(f"/scene/{self.scene.id}/comments/{identity}/reattach", json={"start": 0, "end": 6, "quote": "target"})
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.json["comment"]["detached"])
        self.assertEqual(response.json["comment"]["original_quote"], "target")

    def test_multiple_project_drafts_require_a_choice_and_users_are_isolated(self):
        repository = self.store.drafts
        first, second = StoryProject("First"), StoryProject("Second")
        repository.save(first, None)
        repository.save(second, None)
        fresh = self.app.test_client()
        page = fresh.get("/")
        self.assertIn(b"start-recovery-project", page.data)
        self.assertNotIn(b"data-recovery-dialog", page.data)
        fresh.post("/project/recovery/open", data={"project_id": str(second.project_id)})
        page = fresh.get("/")
        self.assertIn(b"data-recovery-dialog", page.data)
        with fresh.session_transaction() as session:
            self.assertEqual(session["project_id"], str(second.project_id))
        self.app.config["USER_ID"] = "bob"
        bob = self.app.test_client()
        self.assertNotIn(b"start-recovery-project", bob.get("/").data)
        bob.post("/project/recovery/open", data={"project_id": str(first.project_id)})
        with bob.session_transaction() as session:
            self.assertNotEqual(session["project_id"], str(first.project_id))

    def test_ambiguous_recovery_does_not_implicitly_choose_the_initial_project(self):
        self.scene.text = "Recovery for initial project"
        self.store.commit()
        self.store.drafts.save(StoryProject("Other"), None)
        fresh = self.app.test_client()
        page = fresh.get("/")
        self.assertIn(b"start-recovery-project", page.data)
        self.assertNotIn(b"data-recovery-dialog", page.data)
        fresh_store = list(self.app.config["PROJECT_STORES"].values())[-1]
        self.assertEqual(fresh_store.get(), self.app.config["INITIAL_PROJECT"])

    def test_named_open_offers_matching_recovery_and_keeps_other_projects(self):
        baseline = deepcopy(self.store.get())
        self.app.config["PROJECT_LIBRARY"].save("local-user", baseline)
        self.scene.text = "Recovery prose"
        self.store.commit()
        other = StoryProject("Other")
        self.store.drafts.save(other, None)
        response = self.client.post("/project/library-open", data={"project_filename": "Untitled story.verwrity.zip"}, follow_redirects=True)
        self.assertIn(b"data-recovery-dialog", response.data)
        self.assertEqual(self.store.get().scenes[0].text, "Recovery prose")
        self.assertEqual(self.store.drafts.latest(other.project_id).project, other)

    def test_discard_unnamed_recovery_purges_only_selected_project_after_blank_is_saved(self):
        original_id = self.store.get().project_id
        self.store.commit()
        other = StoryProject("Other")
        self.store.drafts.save(other, None)
        response = self.client.post("/project/recovery/discard")
        self.assertEqual(response.status_code, 302)
        self.assertIsNone(self.store.drafts.latest(original_id))
        self.assertEqual(self.store.drafts.latest(other.project_id).project, other)
        self.assertEqual(self.store.drafts.latest(self.store.get().project_id).project, self.store.get())

    def test_discard_named_recovery_removes_unsaved_fallbacks_and_keeps_saved_baseline(self):
        baseline = deepcopy(self.store.get())
        named = self.app.config["PROJECT_LIBRARY"].save("local-user", baseline)
        self.store.commit()
        self.scene.text = "Unsaved recovery prose"
        self.store.commit()
        response = self.client.post("/project/recovery/discard", data={"saved_project_filename": named.name})
        self.assertEqual(response.status_code, 302)
        self.assertEqual(self.store.get(), baseline)
        directory = self.store.drafts.directory(baseline.project_id)
        self.assertEqual([path.name for path in directory.glob("*.verwrity.zip")], ["current.verwrity.zip"])
        self.assertEqual(self.store.drafts.latest(baseline.project_id).project, baseline)

    def test_failed_discard_replacement_keeps_recovered_project_available(self):
        original = deepcopy(self.store.get())
        self.store.commit()
        with patch("verwrity.project.drafts.atomic_write", side_effect=OSError("disk full")):
            response = self.client.post("/project/recovery/discard")
        self.assertEqual(response.status_code, 503)
        self.assertEqual(self.store.get(), original)
        self.assertEqual(self.store.drafts.latest(original.project_id).project, original)
