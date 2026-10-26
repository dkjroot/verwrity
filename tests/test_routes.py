import json
import tempfile
import unittest
from io import BytesIO
from pathlib import Path
from uuid import uuid4
from unittest.mock import patch

from verwrity.domain.story import ManuscriptComment, StoryProject, StoryboardColumn, WikiPage
from verwrity.project.library import ProjectLibrary
from verwrity.project.preferences import UserPreferences
from verwrity.project.archive import export_project
from verwrity.project.store import ProjectStore
from verwrity.web.app import create_app


class WorkspaceRoutesTest(unittest.TestCase):
    def setUp(self) -> None:
        self.project = StoryProject.demo()
        self.app = create_app(ProjectStore(self.project))
        self.library_directory = tempfile.TemporaryDirectory()
        self.app.config["PROJECT_LIBRARY"] = ProjectLibrary(Path(self.library_directory.name))
        self.app.config["PROJECT_DRAFT_ROOT"] = Path(self.library_directory.name) / ".drafts"
        self.app.extensions["user_preferences"] = UserPreferences(Path(self.library_directory.name))
        self.client = self.app.test_client()
        self.client.get("/")
        self.store = next(iter(self.app.config["PROJECT_STORES"].values()))
        self.scene = self.store.get().scenes[0]

    def tearDown(self) -> None:
        self.library_directory.cleanup()

    def test_project_menus_show_titles_without_partial_extensions(self) -> None:
        project = self.store.get()
        project.title = "A story.v"
        self.app.config["PROJECT_LIBRARY"].save("local-user", project)
        with self.client.session_transaction() as session:
            session.pop("has_chosen_project", None)
        html = self.client.get("/").data.decode()
        option = '<option value="A story.v.verwrity.zip">A story.v</option>'
        self.assertEqual(html.count(option), 2)

    def test_scene_text_endpoint_updates_canonical_scene(self) -> None:
        response = self.client.post(f"/scene/{self.scene.id}/text", data={"scene_text": "Edited scene."})

        self.assertEqual(response.status_code, 204)
        self.assertEqual(self.store.get().scenes[0].text, "Edited scene.")
        self.assertIn("Edited scene.", self.client.get("/").data.decode())

    def test_manuscript_search_and_replace_only_change_current_scene_heads(self) -> None:
        project = self.store.get()
        self.scene.text = "Mara meets Mara."
        self.scene.record_revision()
        second = project.scenes[1]
        second.text = "MARA leaves."
        historical = project.scenes[2]
        historical.text = "Mara waits."
        historical.historical = True

        found = self.client.post("/manuscript/search", json={
            "query": "mara", "scope": "project", "active_text": "Mara meets Mara."
        })
        self.assertEqual(found.status_code, 200)
        self.assertEqual(sum(item["count"] for item in found.json["matches"]), 3)

        replaced = self.client.post("/manuscript/replace", json={
            "query": "mara", "replacement": "Nia", "scope": "project", "replace_all": True
        })
        self.assertEqual(replaced.status_code, 200)
        self.assertEqual(replaced.json["count"], 3)
        self.assertEqual(self.scene.text, "Nia meets Nia.")
        self.assertEqual(second.text, "Nia leaves.")
        self.assertEqual(historical.text, "Mara waits.")
        self.assertEqual(self.scene.revisions[0].text, "Mara meets Mara.")

    def test_manuscript_search_can_replace_first_project_match(self) -> None:
        self.scene.text = "key KEY key"
        second = self.store.get().scenes[1]
        second.text = "key elsewhere"
        with self.client.session_transaction() as session:
            session["active_scene_id"] = str(second.id)
        replaced = self.client.post("/manuscript/replace", json={
            "query": "key", "replacement": "lock", "scope": "project", "replace_all": False
        })
        self.assertEqual(replaced.json["count"], 1)
        self.assertEqual(self.scene.text, "lock KEY key")
        self.assertEqual(second.text, "key elsewhere")

    def test_late_search_response_cannot_republish_an_old_scene_selection(self) -> None:
        old_cookie = self.client.get_cookie("session").value
        second = self.store.get().scenes[1]
        selected = self.client.post(f"/scene/select/{second.id}")
        self.assertEqual(selected.status_code, 302)
        self.assertIn("Set-Cookie", selected.headers)
        # Model a request that started with the old cookie but completed after
        # navigation. Its read-only response must not revert the new selection.
        stale_request = self.app.test_client()
        stale_request.set_cookie("session", old_cookie)
        response = stale_request.post("/manuscript/search", json={"query": "Write", "scope": "project"})
        self.assertEqual(response.status_code, 200)
        self.assertNotIn("Set-Cookie", response.headers)
        with self.client.session_transaction() as session:
            self.assertEqual(session["active_scene_id"], str(second.id))

    def test_replace_selected_unicode_match_and_reject_changed_targets(self) -> None:
        self.scene.text = "😀 key KEY key"
        self.scene.record_revision()
        second = self.store.get().scenes[1]
        second.text = "key elsewhere"
        target = {"scene_id": str(self.scene.id), "start": 6, "end": 9, "quote": "KEY"}
        request = {"query": "key", "replacement": "$1\\literal", "scope": "project",
                   "replace_all": False, "target": target, "active_scene_id": str(self.scene.id)}
        response = self.client.post('/manuscript/replace', json=request)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json['count'], 1)
        self.assertEqual(self.scene.text, "😀 key $1\\literal key")
        self.assertEqual(second.text, "key elsewhere")
        self.assertEqual(self.scene.revisions[0].text, "😀 key KEY key")
        self.assertEqual(self.client.post('/manuscript/replace', json=request).status_code, 409)
        request['target'] = {**target, 'start': 2, 'end': 5, 'quote': 'key'}
        request['replacement'] = ''
        request['scene_base_hash'] = 'stale'
        self.assertEqual(self.client.post('/manuscript/replace', json=request).status_code, 409)
        del request['scene_base_hash']
        self.assertEqual(self.client.post('/manuscript/replace', json=request).json['count'], 1)
        self.assertEqual(self.scene.text, "😀  $1\\literal key")
        request['target'] = {**target, 'scene_id': str(second.id)}
        self.assertEqual(self.client.post('/manuscript/replace', json=request).status_code, 409)

    def test_replace_selected_match_retains_comment_and_dialogue_positions(self) -> None:
        from verwrity.domain.dialogue import DialogueAttribution
        self.scene.text = 'key key. "Speech."'
        self.scene.comments = [ManuscriptComment(uuid4(), 10, 16, 'Speech', 'Note')]
        self.scene.dialogue = [DialogueAttribution(uuid4(), None, 10, 17, 'Speech.', 'Speech.')]
        response = self.client.post('/manuscript/replace', json={
            'query': 'key', 'replacement': 'longer', 'replace_all': False,
            'target': {'scene_id': str(self.scene.id), 'start': 4, 'end': 7, 'quote': 'key'}})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.scene.text, 'key longer. "Speech."')
        self.assertEqual(self.scene.comments[0].start, 13)
        self.assertEqual(self.scene.comments[0].quote, 'Speech')
        self.assertEqual(self.scene.dialogue[0].start, 13)
        self.assertFalse(self.scene.dialogue[0].detached)

    def test_manuscript_search_can_match_case_and_replace_only_exact_case(self) -> None:
        self.scene.text = "Mara MARA mara"
        found = self.client.post("/manuscript/search", json={
            "query": "Mara", "scope": "current_scene", "case_sensitive": True,
        })
        self.assertEqual(found.json["matches"], [{"scene_id": str(self.scene.id), "count": 1}])
        replaced = self.client.post("/manuscript/replace", json={
            "query": "Mara", "replacement": "Nia", "scope": "current_scene",
            "case_sensitive": True, "replace_all": True,
        })
        self.assertEqual(replaced.json["count"], 1)
        self.assertEqual(self.scene.text, "Nia MARA mara")

    def test_scene_selection_saves_previous_scene_before_switching(self) -> None:
        second = self.store.get().scenes[1]
        with self.client.session_transaction() as session:
            session["active_scene_id"] = str(self.scene.id)

        self.client.post(f"/scene/{self.scene.id}/text", data={"scene_text": "Saved before switch."})
        response = self.client.post(f"/scene/select/{second.id}")

        self.assertEqual(response.status_code, 302)
        self.assertEqual(self.store.get().scenes[0].text, "Saved before switch.")
        with self.client.session_transaction() as session:
            self.assertEqual(session["active_scene_id"], str(second.id))

    def test_ai_passage_navigation_rechecks_current_quote_and_windows_offsets(self) -> None:
        target = self.store.get().scenes[1]
        target.text = "New prefix 🕯️.\r\n\r\nMara found it.\r\nIt was blue."
        target.record_revision()
        quote = "Mara found it.\nIt was blue."
        normalized = target.text.replace("\r\n", "\n")
        start = normalized.index(quote)
        response = self.client.post(f"/scene/select/{target.id}", data={
            "ai_start": 0, "ai_end": 10, "ai_quote": quote,
        })
        self.assertEqual(response.location, f"/?ai_start={start}&ai_end={start + len(quote)}")
        self.assertIn(f'data-ai-passage-start="{start}"', self.client.get(response.location).text)
        self.assertEqual(target.text, "New prefix 🕯️.\r\n\r\nMara found it.\r\nIt was blue.")
        self.assertEqual(target.revisions[0].text, target.text)

    def test_ai_passage_navigation_does_not_highlight_removed_or_historical_evidence(self) -> None:
        target = self.store.get().scenes[1]
        target.text = "The replacement text."
        payload = {"ai_start": 0, "ai_end": 5, "ai_quote": "Gone passage"}
        self.assertEqual(self.client.post(f"/scene/select/{target.id}", data=payload).location, "/")
        target.historical = True
        payload["ai_quote"] = "The replacement text."
        self.assertEqual(self.client.post(f"/scene/select/{target.id}", data=payload).location, "/")

    def test_scene_revision_restore_preserves_current_head_as_next_revision(self) -> None:
        self.scene.text = "Revision one text."
        recorded = self.client.post(f"/scene/{self.scene.id}/revisions/record")
        self.assertEqual(recorded.status_code, 200)
        first_revision = recorded.json["revision"]
        self.assertEqual(first_revision["number"], 1)

        self.client.post(f"/scene/{self.scene.id}/text", data={"scene_text": "Current head text."})
        restored = self.client.post(f"/scene/{self.scene.id}/revisions/{first_revision['id']}/restore")

        self.assertEqual(restored.status_code, 200)
        self.assertEqual(self.scene.text, "Revision one text.")
        self.assertEqual([item.number for item in self.scene.revisions], [1, 2])
        self.assertEqual(self.scene.revisions[-1].text, "Current head text.")
        self.assertEqual(restored.json["next_revision_number"], 3)

    def test_remove_marks_scene_historical_and_move_preserves_identity(self) -> None:
        second = self.store.get().scenes[1]
        original_ids = [scene.id for scene in self.store.get().scenes]

        self.client.post(f"/scene/{second.id}/move", data={"direction": "up"})
        self.assertEqual([scene.id for scene in self.store.get().current_scenes()], [original_ids[1], original_ids[0], original_ids[2]])

        self.client.post(f"/scene/{second.id}/remove")
        removed = self.store.get().scene(second.id)
        self.assertTrue(removed.historical)
        self.assertEqual(removed.id, original_ids[1])

    def test_project_library_save_and_open_round_trip(self) -> None:
        self.client.post(f"/scene/{self.scene.id}/text", data={"scene_text": "Saved source."})
        saved = self.client.post("/project/library-save", data={"project_title": "Route test"})
        self.assertEqual(saved.status_code, 302)
        self.assertEqual(self.app.config["PROJECT_LIBRARY"].list("local-user"), ["Route test.verwrity.zip"])

        self.store.get().scenes[0].text = "Different draft."
        opened = self.client.post("/project/library-open", data={"project_filename": "Route test.verwrity.zip"})

        self.assertEqual(opened.status_code, 302)
        self.assertEqual(self.store.get().scenes[0].text, "Saved source.")

    def test_next_visit_offers_recovery_of_a_newer_autosaved_project(self) -> None:
        draft_root = self.app.config["PROJECT_DRAFT_ROOT"]
        self.client.post(f"/scene/{self.scene.id}/text", data={"scene_text": "Named baseline."})
        self.client.post("/project/library-save", data={"project_title": "Recovery test"})
        self.client.post(f"/scene/{self.scene.id}/text", data={"scene_text": "Autosaved recovery text."})

        fresh_app = create_app(ProjectStore(StoryProject.demo()))
        fresh_app.config["PROJECT_LIBRARY"] = self.app.config["PROJECT_LIBRARY"]
        fresh_app.config["PROJECT_DRAFT_ROOT"] = draft_root
        fresh_app.extensions["user_preferences"] = self.app.extensions["user_preferences"]
        fresh_client = fresh_app.test_client()
        response = fresh_client.get("/")

        self.assertEqual(response.status_code, 200)
        self.assertIn(b"Recover autosaved project?", response.data)
        recovered = fresh_client.post("/project/recovery/continue")
        self.assertEqual(recovered.status_code, 302)
        self.assertNotIn(b"data-recovery-dialog", fresh_client.get("/").data)
        self.assertEqual(next(iter(fresh_app.config["PROJECT_STORES"].values())).get().scenes[0].text, "Autosaved recovery text.")

    def test_recovery_can_discard_draft_and_reopen_matching_named_project(self) -> None:
        draft_root = self.app.config["PROJECT_DRAFT_ROOT"]
        self.client.post(f"/scene/{self.scene.id}/text", data={"scene_text": "Named baseline."})
        self.client.post("/project/library-save", data={"project_title": "Recovery discard test"})
        self.client.post(f"/scene/{self.scene.id}/text", data={"scene_text": "Temporary draft."})

        fresh_app = create_app(ProjectStore(StoryProject.demo()))
        fresh_app.config["PROJECT_LIBRARY"] = self.app.config["PROJECT_LIBRARY"]
        fresh_app.config["PROJECT_DRAFT_ROOT"] = draft_root
        fresh_app.extensions["user_preferences"] = self.app.extensions["user_preferences"]
        fresh_client = fresh_app.test_client()
        self.assertIn(b"Recover autosaved project?", fresh_client.get("/").data)

        response = fresh_client.post("/project/recovery/discard", data={
            "saved_project_filename": "Recovery discard test.verwrity.zip",
        })

        self.assertEqual(response.status_code, 302)
        self.assertEqual(next(iter(fresh_app.config["PROJECT_STORES"].values())).get().scenes[0].text, "Named baseline.")
        self.assertNotIn(b"data-recovery-dialog", fresh_client.get("/").data)

    def test_invalid_scene_analysis_does_not_mutate_project(self) -> None:
        before = self.store.get().scenes[0].text
        response = self.client.post(f"/scene/{self.scene.id}/spell-check", data={"scene_text": "The quik fox."})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["annotations"][0]["word"], "quik")
        self.assertEqual(self.store.get().scenes[0].text, before)

    def test_manuscript_comments_validate_ranges_and_preserve_canonical_text(self) -> None:
        self.scene.text = "Mara found the silver key."
        original_text = self.scene.text
        payload = {"start": 0, "end": 4, "quote": "Mara", "body": "Check this detail."}

        added = self.client.post(f"/scene/{self.scene.id}/comments", json=payload)

        self.assertEqual(added.status_code, 200)
        self.assertEqual(added.json["comment"]["quote"], "Mara")
        self.assertEqual(added.json["comment"]["body"], "Check this detail.")
        self.assertEqual(self.scene.text, original_text)
        self.assertEqual(len(self.scene.comments), 1)

        for invalid in (
            {**payload, "start": True},
            {**payload, "start": -1},
            {**payload, "end": len(original_text) + 1},
            {**payload, "quote": "Mara "},
            {**payload, "body": "  "},
        ):
            rejected = self.client.post(f"/scene/{self.scene.id}/comments", json=invalid)
            self.assertEqual(rejected.status_code, 400, invalid)
        self.assertEqual(len(self.scene.comments), 1, "Rejected comments do not create partial data")
        self.assertEqual(self.scene.text, original_text)

    def test_manuscript_comment_lifecycle_and_optional_todo_preserve_text(self) -> None:
        self.scene.text = "Mara found the silver key."
        todo = WikiPage(uuid4(), "To-do", "- [ ] Existing task", aliases=("TODO",))
        self.store.get().wiki_pages.append(todo)
        original_text = self.scene.text

        response = self.client.post(f"/scene/{self.scene.id}/comments", json={
            "start": 15, "end": 25, "quote": "silver key", "body": "Ask who left it.", "add_to_todo": True,
        })
        self.assertEqual(response.status_code, 200)
        comment = response.json["comment"]
        self.assertTrue(comment["added_to_todo"])
        self.assertEqual(response.json["todo_page"]["id"], str(todo.id))
        self.assertIn("Existing task", response.json["todo_page"]["body"])
        self.assertIn("Opening: “silver key”", response.json["todo_page"]["body"])

        comment_id = comment["id"]
        resolved = self.client.post(f"/scene/{self.scene.id}/comments/{comment_id}/resolve", json={"resolved": True})
        self.assertEqual(resolved.status_code, 200)
        self.assertTrue(resolved.json["comment"]["resolved"])
        reopened = self.client.post(f"/scene/{self.scene.id}/comments/{comment_id}/resolve", json={"resolved": False})
        self.assertEqual(reopened.status_code, 200)
        self.assertFalse(reopened.json["comment"]["resolved"])
        self.assertEqual(self.scene.text, original_text)

        deleted = self.client.post(f"/scene/{self.scene.id}/comments/{comment_id}/delete")
        self.assertEqual(deleted.status_code, 200)
        self.assertEqual(self.scene.comments, [])
        self.assertEqual(self.scene.text, original_text)

    def test_manuscript_comment_anchor_updates_only_for_existing_ids_and_valid_ranges(self) -> None:
        self.scene.text = "Before, Mara finds a key."
        comment = ManuscriptComment(uuid4(), 8, 12, "Mara", "Review this name.")
        self.scene.comments.append(comment)

        response = self.client.post(f"/scene/{self.scene.id}/text", data={
            "scene_text": "Before, Lady Mara finds a key.",
            "scene_comments": json.dumps([
                {"id": str(comment.id), "start": 13, "end": 17},
                {"id": str(uuid4()), "start": 0, "end": 6},
                {"id": str(comment.id), "start": -1, "end": 4},
            ]),
        })

        self.assertEqual(response.status_code, 204)
        self.assertEqual(self.scene.text, "Before, Lady Mara finds a key.")
        self.assertEqual((comment.start, comment.end, comment.quote), (13, 17, "Mara"))
        self.assertEqual(comment.body, "Review this name.")

    def test_add_scene_creates_and_selects_scene(self) -> None:
        response = self.client.post("/scene/add", data={"scene_title": "New scene", "scene_summary": "A new beat."})

        self.assertEqual(response.status_code, 302)
        self.assertEqual(self.store.get().scenes[-1].title, "New scene")
        self.assertEqual(self.store.get().scenes[-1].summary, "A new beat.")
        with self.client.session_transaction() as session:
            self.assertEqual(session["active_scene_id"], str(self.store.get().scenes[-1].id))

    def test_storyboard_saves_order_and_descriptions_then_returns_to_writing(self) -> None:
        scenes = self.store.get().current_scenes()
        submitted_order = [scenes[1], scenes[2], scenes[0]]
        data = {"intent": "save", "scene_id": [str(scene.id) for scene in submitted_order]}
        data.update({f"summary_{scene.id}": f"Description for {scene.title}" for scene in scenes})

        response = self.client.post("/storyboard/save", data=data)

        self.assertEqual(response.status_code, 302)
        self.assertEqual(response.headers["Location"], "/")
        project = self.store.get()
        self.assertEqual(project.current_scenes(), submitted_order)
        self.assertEqual(
            {scene.title: scene.summary for scene in project.scenes},
            {scene.title: f"Description for {scene.title}" for scene in scenes},
        )
        self.assertEqual(self.client.get("/").status_code, 200)

    def test_storyboard_add_stays_on_board_and_selects_new_scene(self) -> None:
        scenes = self.store.get().current_scenes()
        data = {
            "intent": "add",
            "scene_id": [str(scene.id) for scene in scenes],
            **{f"summary_{scene.id}": scene.summary for scene in scenes},
            "new_scene_title": "A new beat",
            "new_scene_summary": "The characters make a choice.",
        }

        response = self.client.post("/storyboard/save", data=data)

        self.assertEqual(response.status_code, 302)
        self.assertEqual(response.headers["Location"], "/storyboard")
        added = self.store.get().current_scenes()[-1]
        self.assertEqual((added.title, added.summary), ("A new beat", "The characters make a choice."))
        with self.client.session_transaction() as session:
            self.assertEqual(session["active_scene_id"], str(added.id))
        self.assertIn(b"A new beat", self.client.get("/storyboard").data)

    def test_storyboard_delete_keeps_scene_historical_and_returns_to_writing(self) -> None:
        scenes = self.store.get().current_scenes()
        deleted = scenes[0]
        with self.client.session_transaction() as session:
            session["active_scene_id"] = str(deleted.id)
        data = {
            "intent": "delete",
            "delete_scene_id": str(deleted.id),
            "scene_id": [str(scene.id) for scene in scenes],
            **{f"summary_{scene.id}": scene.summary for scene in scenes},
        }

        response = self.client.post("/storyboard/save", data=data)

        self.assertEqual(response.status_code, 302)
        self.assertEqual(response.headers["Location"], "/")
        self.assertTrue(self.store.get().scene(deleted.id).historical)
        self.assertEqual(len(self.store.get().current_scenes()), len(scenes) - 1)
        with self.client.session_transaction() as session:
            self.assertNotIn("active_scene_id", session)

    def test_scene_summary_is_available_as_main_page_title_tooltip(self) -> None:
        self.scene.summary = "A clue changes the plan."

        response = self.client.get("/")

        self.assertIn(b'title="A clue changes the plan."', response.data)

    def test_storyboard_grid_adds_columns_edits_cells_and_deletes_column_data(self) -> None:
        scenes = self.store.get().current_scenes()
        add_data = {
            "intent": "add_column",
            "scene_id": [str(scene.id) for scene in scenes],
            "new_column_title": "Alice and Bob",
        }
        add_data.update({f"scene_title_{scene.id}": scene.title for scene in scenes})
        add_data.update({f"scene_summary_{scene.id}": scene.summary for scene in scenes})

        added = self.client.post("/storyboard/grid/save", data=add_data)

        self.assertEqual(added.status_code, 302)
        self.assertEqual(added.headers["Location"], "/storyboard?view=grid")
        column = self.store.get().storyboard_columns[0]
        scenes = self.store.get().current_scenes()
        first = scenes[0]
        save_data = {
            "intent": "return",
            "scene_id": [str(scene.id) for scene in scenes],
            "column_id": [str(column.id)],
            f"scene_title_{first.id}": "Opening revised",
            f"scene_summary_{first.id}": "The mystery begins.",
            f"cell_{first.id}_{column.id}": "They do not trust each other yet.",
        }
        for scene in scenes[1:]:
            save_data[f"scene_title_{scene.id}"] = scene.title
            save_data[f"scene_summary_{scene.id}"] = scene.summary
            save_data[f"cell_{scene.id}_{column.id}"] = ""
        save_data[f"column_title_{column.id}"] = "Alice / Bob"

        saved = self.client.post("/storyboard/grid/save", data=save_data)

        self.assertEqual(saved.headers["Location"], "/")
        updated = self.store.get().scene(first.id)
        self.assertEqual((updated.title, updated.summary), ("Opening revised", "The mystery begins."))
        self.assertEqual(self.store.get().storyboard_columns[0].title, "Alice / Bob")
        self.assertEqual(self.store.get().storyboard_value(first.id, column.id), "They do not trust each other yet.")

        reordered_scenes = list(reversed(self.store.get().current_scenes()))
        reorder_data = {"intent": "save", "scene_id": [str(scene.id) for scene in reordered_scenes]}
        reorder_data.update({f"summary_{scene.id}": scene.summary for scene in reordered_scenes})
        self.client.post("/storyboard/save", data=reorder_data)
        self.assertEqual(self.store.get().current_scenes(), reordered_scenes)
        self.assertEqual(self.store.get().storyboard_value(first.id, column.id), "They do not trust each other yet.")

        delete_data = {
            "intent": "delete_column",
            "delete_column_id": str(column.id),
            "scene_id": [str(scene.id) for scene in self.store.get().current_scenes()],
            "column_id": [str(column.id)],
        }
        for scene in self.store.get().current_scenes():
            delete_data[f"scene_title_{scene.id}"] = scene.title
            delete_data[f"scene_summary_{scene.id}"] = scene.summary
            delete_data[f"cell_{scene.id}_{column.id}"] = self.store.get().storyboard_value(scene.id, column.id)
        delete_data[f"column_title_{column.id}"] = "Alice / Bob"

        deleted = self.client.post("/storyboard/grid/save", data=delete_data)

        self.assertEqual(deleted.headers["Location"], "/storyboard?view=grid")
        self.assertEqual(self.store.get().storyboard_columns, [])
        self.assertEqual(self.store.get().storyboard_cells, {})

    def test_storyboard_view_switch_saves_note_edits(self) -> None:
        scenes = self.store.get().current_scenes()
        data = {
            "intent": "view_grid",
            "scene_id": [str(scene.id) for scene in scenes],
            **{f"summary_{scene.id}": "Updated in notes" if scene == scenes[0] else scene.summary for scene in scenes},
        }

        response = self.client.post("/storyboard/save", data=data)

        self.assertEqual(response.headers["Location"], "/storyboard?view=grid")
        self.assertEqual(self.store.get().scenes[0].summary, "Updated in notes")
        self.assertIn(b"Storyboard scene details", self.client.get("/storyboard?view=grid").data)

        column = StoryboardColumn(uuid4(), "The hidden truth")
        self.store.get().storyboard_columns.append(column)
        grid_data = {
            "intent": "view_notes",
            "scene_id": [str(scene.id) for scene in scenes],
            "column_id": [str(column.id)],
        }
        grid_data.update({f"scene_title_{scene.id}": scene.title for scene in scenes})
        grid_data.update({f"scene_summary_{scene.id}": scene.summary for scene in scenes})
        grid_data.update({f"cell_{scene.id}_{column.id}": "Reader suspects" for scene in scenes})
        grid_data[f"column_title_{column.id}"] = column.title

        switched_back = self.client.post("/storyboard/grid/save", data=grid_data)

        self.assertEqual(switched_back.headers["Location"], "/storyboard?view=notes")
        self.assertEqual(self.store.get().storyboard_value(scenes[0].id, column.id), "Reader suspects")

    def test_create_wiki_page_from_selected_title_preserves_manuscript(self) -> None:
        before = self.store.get().scenes[0].text
        response = self.client.post("/wiki/page/create", data={"title": "  Alice   Example  "})

        self.assertEqual(response.status_code, 302)
        self.assertEqual(self.store.get().scenes[0].text, before)
        self.assertEqual(self.store.get().wiki_pages[-1].title, "Alice Example")

        self.client.post("/wiki/page/create", data={"title": "alice example"})
        self.assertEqual([page.title for page in self.store.get().wiki_pages].count("Alice Example"), 1)

    def test_wiki_page_can_be_edited_without_changing_its_identity(self) -> None:
        page = self.store.get().wiki_pages[0]

        response = self.client.post(f"/wiki/page/{page.id}/save", data={"title": "Updated notes", "body": "Links to [[Characters]]."})

        self.assertEqual(response.status_code, 302)
        updated = next(item for item in self.store.get().wiki_pages if item.id == page.id)
        self.assertEqual((updated.title, updated.body), ("Updated notes", "Links to [[Characters]]."))
        self.assertEqual(self.client.get(f"/?wiki_page={page.id}").status_code, 200)

    def test_wiki_aliases_resolve_and_are_unique(self) -> None:
        first, second = self.store.get().wiki_pages
        response = self.client.post(f"/wiki/page/{first.id}/save", data={
            "title": first.title, "aliases": " Notes, Mara, notes ", "body": "A page.",
        })
        self.assertEqual(response.status_code, 302)
        self.assertEqual(self.store.get().wiki_pages[0].aliases, ("Notes", "Mara"))
        html = self.client.get("/").data.decode()
        self.assertIn('data-aliases="Notes, Mara"', html)

        response = self.client.post(f"/wiki/page/{second.id}/save", data={
            "title": second.title, "aliases": "mara", "body": "Should be rejected.",
        })
        self.assertEqual(response.status_code, 302)
        self.assertEqual(self.store.get().wiki_pages[1].aliases, ())

    def test_wiki_page_delete_removes_only_the_selected_page(self) -> None:
        pages = self.store.get().wiki_pages
        deleted_id = pages[0].id
        remaining_id = pages[1].id

        response = self.client.post(f"/wiki/page/{deleted_id}/delete")

        self.assertEqual(response.status_code, 302)
        self.assertEqual([page.id for page in self.store.get().wiki_pages], [remaining_id])

    def test_wiki_page_titles_must_remain_unique_when_edited(self) -> None:
        first, second = self.store.get().wiki_pages

        response = self.client.post(f"/wiki/page/{first.id}/save", data={"title": second.title, "body": "Changed"})

        self.assertEqual(response.status_code, 302)
        self.assertEqual(self.store.get().wiki_pages[0].title, first.title)

    def test_wiki_rename_updates_links_and_restores_from_history(self) -> None:
        first, second = self.store.get().wiki_pages
        self.store.get().wiki_pages[1] = type(second)(second.id, second.title, "See [[Project notes|the notes]].")

        self.client.post(f"/wiki/page/{first.id}/save", data={
            "title": "Research notes", "body": "Updated.", "tags": "reference, Reference, plot",
        })
        renamed = self.store.get().wiki_pages[0]
        linked = self.store.get().wiki_pages[1]
        self.assertEqual(renamed.tags, ("reference", "plot"))
        self.assertEqual(linked.body, "See [[Research notes|the notes]].")
        self.assertEqual(len(renamed.revisions), 1)
        self.assertEqual(len(linked.revisions), 1)

        restored = self.client.post(f"/wiki/page/{first.id}/restore/{renamed.revisions[0].id}")
        self.assertEqual(restored.status_code, 302)
        self.assertEqual(self.store.get().wiki_pages[0].title, "Project notes")
        self.assertEqual(self.store.get().wiki_pages[1].body, "See [[Project notes|the notes]].")
        self.assertEqual(len(self.store.get().wiki_pages[0].revisions), 2)

    def test_project_duplicate_new_export_and_import_routes(self) -> None:
        duplicate = self.client.post("/project/duplicate", data={"duplicate_title": "A copy"})
        self.assertEqual(duplicate.status_code, 302)
        self.assertIn("A copy.verwrity.zip", self.app.config["PROJECT_LIBRARY"].list("local-user"))

        new = self.client.post("/project/new")
        self.assertEqual(new.status_code, 302)
        self.assertEqual(self.store.get().title, "Untitled story")
        self.assertEqual(len(self.store.get().scenes), 1)
        self.assertEqual(self.store.get().scenes[0].title, "Scene 1")
        self.assertEqual(self.store.get().scenes[0].text, "")
        self.assertEqual(self.store.get().wiki_pages, [])
        with self.client.session_transaction() as session:
            self.assertEqual(session["active_scene_id"], str(self.store.get().scenes[0].id))
        named = self.app.config["PROJECT_LIBRARY"].find_project_id("local-user", self.store.get().project_id)
        self.assertEqual(named[1], self.store.get())

        exported = self.client.post("/project/save", data={"project_title": "Download"})
        self.assertEqual(exported.status_code, 200)
        self.assertEqual(exported.mimetype, "application/zip")
        self.assertEqual(exported.headers["Content-Disposition"],
                         "attachment; filename=Download.verwrity.zip")

        imported = self.client.post("/project/open", data={
            "project_file": (BytesIO(export_project(self.project)[1]), "import.verwrity.zip"),
        }, content_type="multipart/form-data")
        self.assertEqual(imported.status_code, 302)

    def test_named_new_project_and_failed_creation_preserve_previous_work(self):
        previous = self.store.get()
        self.scene.text = "Keep this manuscript."
        self.store.commit()
        with patch.object(self.app.config["PROJECT_LIBRARY"], "save", side_effect=OSError("write failed")):
            failed = self.client.post("/project/new", data={"project_title": "New story"})
        self.assertEqual(failed.status_code, 503)
        self.assertEqual(self.store.get().project_id, previous.project_id)
        self.assertEqual(self.store.get().scenes[0].text, "Keep this manuscript.")
        response = self.client.post("/project/new", data={"project_title": "New story"})
        self.assertEqual(response.status_code, 302)
        current = self.store.get()
        self.assertEqual(current.title, "New story")
        self.assertNotEqual(current.project_id, previous.project_id)
        self.assertEqual(self.app.config["PROJECT_LIBRARY"].find_project_id("local-user", current.project_id)[1], current)
        self.assertIn(b'data-project-needs-save="false"', self.client.get("/").data)
        self.client.post(f"/scene/{current.scenes[0].id}/text", data={"scene_text": "New prose."})
        self.assertIn(b'data-project-needs-save="true"', self.client.get("/").data)
        self.client.post("/project/library-save", data={"project_title": current.title})
        self.assertIn(b'data-project-needs-save="false"', self.client.get("/").data)

    def test_invalid_project_actions_are_rejected_without_crashing(self) -> None:
        self.assertEqual(self.client.post("/project/library-open", data={"project_filename": "missing.verwrity.zip"}).status_code, 302)
        self.assertEqual(self.client.post("/project/open").status_code, 302)
        self.assertEqual(self.client.post("/project/open", data={
            "project_file": (BytesIO(b"not a zip"), "bad.verwrity.zip"),
        }, content_type="multipart/form-data").status_code, 400)
        self.assertEqual(self.client.post("/scene/not-a-uuid/spell-check", data={"scene_text": "text"}).status_code, 404)


if __name__ == "__main__":
    unittest.main()
