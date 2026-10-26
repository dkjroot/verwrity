"""Wiki world records preserve author sources, stable links and opt-in gates."""

from copy import deepcopy
from dataclasses import replace
from io import BytesIO
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
from uuid import uuid4
from zipfile import ZipFile

from verwrity.ai.settings import UserAISettings
from verwrity.ai.interrogation import select_context, validate_evidence
from verwrity.analysis.wiki import page_hash
from verwrity.analysis.wiki import prepare_wiki, populate_wiki
from verwrity.domain.project_features import ProjectFeatures
from verwrity.domain.story import StoryProject, WikiPage
from verwrity.domain.world import (CharacterSheet, MapLocation, WorldMap, WorldPage,
    read_record, record_data)
from verwrity.project.archive import export_project, import_project
from verwrity.project.library import ProjectLibrary
from verwrity.project.preferences import UserPreferences
from verwrity.project.text_analysis import UserTextAnalyses
from verwrity.project.store import ProjectStore
from verwrity.web.app import create_app
from verwrity.web.routes.wiki import _revision
from verwrity.web.routes.scenes import _append_todo
from verwrity.web.services.world import world_hash


class WorldAuthoringTest(unittest.TestCase):
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
        self.source = deepcopy(self.project)

    def post(self, url, data):
        return self.client.post(url, json={"revision": world_hash(self.project), **data},
            headers={"X-Verwrity-Project-Id": str(self.project.project_id)})

    def enable(self, map=True, characters=True):
        self.project.features = ProjectFeatures(map_editor=map, character_editor=characters)

    def create_map(self, title="Coast"):
        response = self.post("/world/maps", {"title": title})
        self.assertEqual(response.status_code, 200, response.json)
        return self.project.maps[-1]

    def location(self, world_map, title="Harbour", x=0, y=0):
        response = self.post("/world/pages", {"kind": "location", "title": title,
            "record": {"location_id": title.lower(), "map_id": str(world_map.id), "x": x, "y": y}})
        self.assertEqual(response.status_code, 200, response.json)
        return next(page for page in self.project.wiki_pages if str(page.id) == response.json["page"]["id"])

    def character(self, title="Mara", **data):
        response = self.post("/world/pages", {"kind": "character", "title": title,
            "record": {"character_id": title.lower(), **data}})
        self.assertEqual(response.status_code, 200, response.json)
        return next(page for page in self.project.wiki_pages if str(page.id) == response.json["page"]["id"])

    def test_default_workspace_and_disabled_routes_have_no_tools(self):
        html = self.client.get("/").get_data(as_text=True)
        for marker in ["data-open-world-map", "data-new-world-character", "data-world-map-grid"]:
            self.assertNotIn(marker, html)
        self.assertEqual(self.client.get("/world/state").status_code, 404)
        self.assertEqual(self.client.get("/world/fragment").get_data(as_text=True).strip(), "")
        for url in ["/world/maps", "/world/pages", f"/world/pages/{self.project.wiki_pages[0].id}"]:
            self.assertEqual(self.post(url, {"kind": "character", "record": {"character_id": "mara"}}).status_code, 404)
        self.assertEqual(self.project, self.source)

    def test_individual_features_gate_both_forms_and_mutations(self):
        self.enable(map=True, characters=False)
        world_map = self.create_map()
        location = self.location(world_map)
        self.project.features = ProjectFeatures(fingal_mode=True)
        self.assertEqual(self.client.get(f"/world/pages/{location.id}/editor/character").status_code, 409)
        self.enable(map=True, characters=False)
        self.assertEqual(self.post("/world/pages", {"kind": "character", "title": "Mara", "record": {"character_id": "mara"}}).status_code, 404)
        self.assertEqual(self.client.get(f"/world/pages/{location.id}/editor/character").status_code, 404)
        html = self.client.get("/").get_data(as_text=True)
        self.assertIn("data-open-world-map", html)
        self.assertNotIn("data-new-world-character", html)
        self.enable(map=False, characters=True)
        character = self.character(home_location=str(location.id))
        self.assertEqual(self.post("/world/maps", {"title": "Forbidden"}).status_code, 404)
        self.assertEqual(self.client.get(f"/world/pages/{location.id}/editor/location").status_code, 404)
        self.assertEqual(self.client.get(f"/world/pages/{character.id}/editor/character").status_code, 200)

    def test_authoring_keeps_manuscript_wiki_prose_and_provenance_unchanged(self):
        self.enable()
        world_map = self.create_map()
        location = self.location(world_map)
        page = self.project.wiki_pages[0]
        response = self.post(f"/world/pages/{page.id}", {"kind": "character", "page_hash": page_hash(page),
            "record": {"character_id": "mara", "home_location": str(location.id), "combat": {"might": 4},
                "inventory": [{"item": "sword", "quantity": 1}], "equipped": [{"item": "sword", "slot": "right_hand"}]}})
        self.assertEqual(response.status_code, 200, response.json)
        updated = self.project.wiki_pages[0]
        self.assertEqual(updated.body, page.body)
        self.assertEqual(updated.annotations, page.annotations)
        self.assertEqual(updated.title, page.title)
        self.assertEqual(updated.id, page.id)
        self.assertEqual(self.project.scenes, self.source.scenes)
        self.assertEqual(updated.revisions[-1].world.kind, "note")
        self.assertEqual(updated.world.provenance, "human-authored")
        self.assertEqual(self.store.drafts.latest(self.project.project_id).project, self.project)

    def test_create_can_explicitly_adopt_existing_wiki_title_or_alias(self):
        self.enable()
        world_map = self.create_map()
        for kind, title, record in [("character", "Mara Vale", {"character_id": "mara"}),
                ("location", "Lantern Inn", {"location_id": "inn", "map_id": str(world_map.id), "x": 1})]:
            page = WikiPage(uuid4(), title, body="Author's existing knowledge.", aliases=("The " + title,))
            self.project.wiki_pages.append(page)
            original = deepcopy(self.project)
            data = {"kind": kind, "title": ("the " + title).upper(), "record": record}
            conflict = self.post("/world/pages", data)
            self.assertEqual(conflict.status_code, 409)
            self.assertTrue(conflict.json["existing_page"]["can_adopt"])
            self.assertEqual(self.project, original)
            adoption = {**data, "adopt_page_id": str(page.id), "page_hash": page_hash(page)}
            self.assertEqual(self.post("/world/pages", {**adoption, "page_hash": "stale"}).status_code, 409)
            response = self.post("/world/pages", adoption)
            self.assertEqual(response.status_code, 200, response.json)
            updated = next(p for p in self.project.wiki_pages if p.id == page.id)
            self.assertEqual(replace(updated, world=page.world, revisions=page.revisions), page)
            self.assertEqual(updated.revisions[-1].body, page.body)
            self.assertEqual(updated.world.kind, kind)
            self.assertEqual(len(self.project.wiki_pages), len(original.wiki_pages))
            snapshot = deepcopy(self.project)
            # Choosing an already adopted record opens it without replacing its settings.
            self.assertEqual(self.post("/world/pages", {**adoption, "page_hash": page_hash(updated), "record": {}}).status_code, 200)
            self.assertEqual(self.project, snapshot)
            opposite = "character" if kind == "location" else "location"
            conflict = self.post("/world/pages", {"kind": opposite, "title": title})
            self.assertFalse(conflict.json["existing_page"]["can_adopt"])
        self.assertEqual(import_project(export_project(self.project)[1]), self.project)

    def test_routes_cross_maps_coordinates_initial_location_and_reference_safety(self):
        self.enable()
        first, second = self.create_map(), self.create_map("Interior")
        harbour = self.location(first)
        room = self.location(second, "Room")
        character = self.character(home_location=str(harbour.id))
        record = record_data(harbour.world.location)
        record["directions"] = [{"direction": "north", "target_page_id": str(room.id), "travel_time": 12}]
        record["inner_locations"] = [{"label": "Enter", "target_page_id": str(room.id)}]
        self.assertEqual(self.post(f"/world/pages/{harbour.id}", {"kind": "location", "page_hash": page_hash(harbour), "record": record}).status_code, 200)
        self.assertEqual(self.post(f"/world/maps/{first.id}", {"title": first.title, "initial_location": str(harbour.id)}).status_code, 200)
        snapshot = deepcopy(self.project)
        self.assertEqual(self.post(f"/world/maps/{first.id}/delete", {}).status_code, 400)
        current_harbour = next(page for page in self.project.wiki_pages if page.id == harbour.id)
        self.assertEqual(self.post(f"/world/pages/{harbour.id}/detach", {"page_hash": page_hash(current_harbour)}).status_code, 400)
        self.assertEqual(self.client.post(f"/wiki/page/{room.id}/delete").status_code, 400)
        self.assertEqual(self.project, snapshot)
        self.assertEqual(self.post("/world/pages", {"kind": "location", "title": "Collision", "record": {
            "location_id": "collision", "map_id": str(first.id), "x": 0, "y": 0}}).status_code, 400)
        self.assertEqual(self.post(f"/world/maps/{second.id}", {"title": second.title, "initial_location": str(harbour.id)}).status_code, 400)
        self.assertEqual(character.world.character.home_location, harbour.id)

    def test_stale_page_world_project_and_failed_write_preserve_data(self):
        self.enable()
        page = self.character()
        original = deepcopy(self.project)
        data = {"kind": "character", "page_hash": page_hash(page), "record": {"character_id": "mara", "age": 30}}
        self.assertEqual(self.post(f"/world/pages/{page.id}", {**data, "revision": "old"}).status_code, 409)
        self.assertEqual(self.post(f"/world/pages/{page.id}", {**data, "page_hash": "old"}).status_code, 409)
        response = self.client.post(f"/world/pages/{page.id}", json={"revision": world_hash(self.project), **data}, headers={"X-Verwrity-Project-Id": str(uuid4())})
        self.assertEqual(response.status_code, 409)
        with patch.object(self.store, "commit", side_effect=OSError("private detail")):
            response = self.post(f"/world/pages/{page.id}", data)
        self.assertEqual(response.status_code, 503)
        self.assertNotIn("private detail", response.get_data(as_text=True))
        self.assertEqual(self.project, original)
        self.assertEqual(self.post(f"/world/pages/{page.id}", data).status_code, 200)

    def test_archive_duplicate_recovery_and_wiki_history_round_trip(self):
        self.enable()
        world_map = self.create_map()
        location = self.location(world_map)
        page = self.character(home_location=str(location.id), combat={"agility": 5})
        record = record_data(page.world.character)
        record["combat"]["agility"] = 7
        response = self.post(f"/world/pages/{page.id}", {"kind": "character", "page_hash": page_hash(page), "record": record})
        self.assertEqual(response.status_code, 200)
        self.project.features = ProjectFeatures()
        data = export_project(self.project)[1]
        self.assertEqual(import_project(data), self.project)
        with ZipFile(BytesIO(data)) as archive:
            self.assertEqual(json.loads(archive.read("manifest.json"))["archive_version"], 10)
            self.assertEqual(json.loads(archive.read("world_maps.json"))[0]["id"], str(world_map.id))
        library = self.app.config["PROJECT_LIBRARY"]
        duplicate = library.load("local-user", library.duplicate("local-user", self.project, "Copy").name)
        self.assertEqual(duplicate.maps, self.project.maps)
        self.assertEqual(duplicate.wiki_pages, self.project.wiki_pages)
        self.project.features = ProjectFeatures(character_editor=True, map_editor=True)
        current = next(p for p in self.project.wiki_pages if p.id == page.id)
        old = current.revisions[-1]
        response = self.client.post(f"/wiki/page/{page.id}/restore/{old.id}")
        self.assertEqual(response.status_code, 302)
        restored = next(p for p in self.project.wiki_pages if p.id == page.id)
        self.assertEqual(restored.world.character.combat.agility, 5)
        self.assertEqual(restored.revisions[-1].world.character.combat.agility, 7)

    def test_wiki_prose_save_and_rename_preserve_world_identity(self):
        self.enable()
        world_map = self.create_map()
        location = self.location(world_map)
        character = self.character(home_location=str(location.id))
        response = self.client.post(f"/wiki/page/{location.id}/save", data={"title": "Old Harbour", "body": "Human wiki prose", "page_hash": page_hash(location)})
        self.assertEqual(response.status_code, 302)
        updated = next(page for page in self.project.wiki_pages if page.id == location.id)
        self.assertEqual(updated.world, location.world)
        self.assertEqual(updated.body, "Human wiki prose")
        self.assertEqual(character.world.character.home_location, location.id)

    def test_structured_context_is_not_exact_prose_evidence(self):
        self.enable()
        character = self.character(backstory="Structured-only secret")
        context = select_context(self.project, None)
        self.assertIn("Structured-only secret", context["text"])
        self.assertEqual(validate_evidence(self.project, {"evidence": [{"source_type": "wiki", "source_id": str(character.id), "quote": "Structured-only secret"}]}, context), [])
        self.assertNotIn("Structured-only secret", select_context(self.project, None, include_wiki=False)["text"])

    def test_ai_population_preserves_human_structured_record(self):
        self.enable()
        page = self.character(combat={"might": 4})
        context, _ = prepare_wiki(self.project, page, "Character background")
        source = self.project.scenes[0]
        updated, _, _ = populate_wiki(self.project, page, "Character background", {
            "insertions": [{"after": "", "text": "Provisional opening reference.", "evidence": [{
                "source_type": "scene", "source_id": str(source.id), "quote": source.text}]}],
            "world": {"character": {"combat": {"might": 0}}},
        }, context, {"standard": "openai_compatible", "model": "test"})
        self.assertIn("Provisional opening reference.", updated.body)
        self.assertTrue(updated.annotations)
        self.assertEqual(updated.world, page.world)
        self.assertEqual(self.project.scenes, self.source.scenes)

    def test_todo_append_preserves_record_in_head_and_revision(self):
        self.enable()
        page = self.character("TODO", backstory="Authored background")
        updated = _append_todo(self.project, self.project.scenes[0], "Write", "Check this sentence")
        self.assertEqual(updated.world, page.world)
        self.assertEqual(updated.revisions[-1].world, page.world)
        self.assertEqual(import_project(export_project(self.project)[1]), self.project)

    def test_archive_rejects_broken_structured_links_and_false_provenance(self):
        self.enable()
        page = self.character()
        data = export_project(self.project)[1]
        for override in [{"provenance": "ai-generated"}, {"character": {"character_id": "mara", "home_location": str(uuid4())}},
                         {"kind": "location"}, {"unexpected": True}]:
            output = BytesIO()
            with ZipFile(BytesIO(data)) as source, ZipFile(output, "w") as target:
                for name in source.namelist():
                    raw = source.read(name)
                    if name == "wiki.json":
                        pages = json.loads(raw)
                        record = next(item for item in pages if item["id"] == str(page.id))
                        record["world"].update(override)
                        raw = json.dumps(pages)
                    target.writestr(name, raw)
            with self.subTest(override=override), self.assertRaises(ValueError):
                import_project(output.getvalue())


class WorldRecordValidationTest(unittest.TestCase):
    def test_invalid_character_fields_and_equipment_are_rejected(self):
        cases = [{"age": True}, {"age": -1}, {"combat": {"might": 9}}, {"nature": "person", "alignment": "evil"},
            {"inventory": [{"item": "sword", "quantity": 0}]}, {"equipped": [{"item": "sword", "slot": "right_hand"}]},
            {"inventory": [{"item": "bag", "mount": "bag"}]}, {"combat": {"skills": ["invented"]}},
            {"goals": [{"id": "g", "description": "Goal", "activation": "friendly"}]}, {"unknown": "x"}]
        for values in cases:
            with self.subTest(values=values), self.assertRaises(ValueError):
                read_record(CharacterSheet, {"character_id": "mara", **values})

    def test_old_versions_default_to_plain_wiki_and_empty_maps(self):
        project = StoryProject.demo()
        data = export_project(project)[1]
        for version in range(1, 8):
            output = BytesIO()
            with ZipFile(BytesIO(data)) as source, ZipFile(output, "w") as target:
                for name in source.namelist():
                    if name == "fingal_source.json" or (name == "world_maps.json" and version < 7):
                        continue
                    raw = source.read(name)
                    if name == "manifest.json":
                        manifest = json.loads(raw); manifest["archive_version"] = version; raw = json.dumps(manifest)
                    if name == "wiki.json":
                        pages = json.loads(raw)
                        if version < 7:
                            for page in pages: page.pop("world")
                        raw = json.dumps(pages)
                    target.writestr(name, raw)
            with self.subTest(version=version):
                restored = import_project(output.getvalue())
                self.assertEqual(restored, project)


if __name__ == "__main__":
    unittest.main()
