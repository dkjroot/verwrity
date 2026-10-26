"""Portable source retention, explicit review and project-isolated transfers."""

from copy import deepcopy
from dataclasses import replace
from io import BytesIO
import json
from pathlib import Path
import unittest
from unittest.mock import patch
from uuid import uuid4

from verwrity.domain.fingal import read_json, MAX_FINGAL_BYTES
from verwrity.domain.project_features import ProjectFeatures
from verwrity.domain.story import StoryProject, WikiPage
from verwrity.domain.world import WorldMap, WorldPage, CharacterSheet, MapLocation, ItemDefinition, InventoryItem, stamp_authorship, record_data
from verwrity.analysis.wiki import page_hash
from verwrity.project.archive import export_project, import_project
from verwrity.project.fingal import import_story, export_story, review
from tests import test_world_authoring


FIXTURE = Path(__file__).parent / "fixtures" / "fingal-format1.json"


class FingalAdapterTest(unittest.TestCase):
    def test_lossless_source_archive_and_no_fabricated_prose(self):
        original = json.loads(FIXTURE.read_text())
        project = import_story(FIXTURE.read_bytes(), FIXTURE.name)
        self.assertEqual(project.scenes, [])
        self.assertTrue(project.features.fingal_mode)
        self.assertTrue(all(not p.body and p.world.provenance == "imported" for p in project.wiki_pages))
        self.assertEqual(export_story(project)[0], original)
        self.assertEqual(import_project(export_project(project)[1]), project)
        self.assertEqual(export_story(import_project(export_project(project)[1]))[0], original)
        self.assertFalse(review(project)["errors"])

    def test_edits_overlay_source_without_losing_extensions_or_mutating_master(self):
        project = import_story(FIXTURE.read_bytes())
        source = project.fingal_source
        index = next(i for i, p in enumerate(project.wiki_pages) if p.title == "Mara Vale")
        page = project.wiki_pages[index]
        world = replace(page.world, character=replace(page.world.character, character_id="mara_vale", age=32,
            inventory=tuple(replace(v, quantity=2) for v in page.world.character.inventory)))
        project.wiki_pages[index] = replace(page, title="Captain Mara", world=stamp_authorship(world, "Captain Mara"))
        snapshot = deepcopy(project)
        bundle, _ = export_story(project)
        self.assertEqual(project, snapshot)
        self.assertEqual(project.fingal_source, source)
        mara = bundle["characters"][0]
        self.assertEqual((mara["name"], mara["character_id"], mara["age"]), ("Captain Mara", "mara_vale", 32))
        self.assertEqual(mara["inventory"][0]["overrides"], {"description": "Engraved with M"})
        self.assertEqual(mara["attributes"], source.bundle["characters"][0]["attributes"])
        self.assertEqual(set(project.wiki_pages[index].world.source.edited_fields), {"age", "character_id", "inventory", "name"})

    def test_new_world_export_and_missing_requirements(self):
        project = StoryProject("Prose master", features=ProjectFeatures(fingal_mode=True))
        self.assertTrue(review(project)["errors"])
        map_id, location_id = uuid4(), uuid4()
        project.maps = [WorldMap(map_id, "The Coast", location_id)]
        project.wiki_pages = [WikiPage(location_id, "Inn", body="Private wiki notes", world=WorldPage(kind="location", location=MapLocation("inn", map_id))),
            WikiPage(uuid4(), "Mara", world=WorldPage(kind="character", character=CharacterSheet("mara", player_template=True, home_location=location_id, inventory=(InventoryItem("lamp"),)))),
            WikiPage(uuid4(), "Lamp", world=WorldPage(kind="item", item=ItemDefinition("lamp", portable=True)))]
        snapshot = deepcopy(project)
        bundle, mapping = export_story(project)
        self.assertEqual(bundle["maps"]["The_Coast"]["initial_location_id"], "The_Coast.inn")
        self.assertEqual(bundle["players"][0]["home_location"], "The_Coast.inn")
        self.assertNotIn("age", bundle["players"][0])
        self.assertNotIn("behaviour", bundle["players"][0])
        self.assertNotIn("money_balance", bundle["players"][0]["inventory"][0])
        self.assertNotIn("Private wiki notes", json.dumps(bundle))
        self.assertTrue(mapping)
        self.assertFalse(review(project)["errors"])
        self.assertEqual(project, snapshot)

    def test_untrusted_input_rejected(self):
        cases = [b'\xff', b'{"format":1,"format":1}', b'{"value":NaN}', b'{"value":1e309}', b'x' * (MAX_FINGAL_BYTES + 1)]
        for data in cases:
            with self.subTest(data=data[:40]), self.assertRaises(ValueError):
                import_story(data)
        original = json.loads(FIXTURE.read_text())
        for mutate in [lambda b: b.update(format=True), lambda b: b["maps"]["coast"].update(initial_location_id="absent"),
                lambda b: b["characters"][0].update(home_location="absent"), lambda b: b["items"].clear(),
                lambda b: b["characters"][0].update(bonds={"ghost": "ally"}), lambda b: b["characters"][0].update(age=True),
                lambda b: b["maps"]["coast"]["locations"]["coast.quay"].update(x=0.5),
                lambda b: b["maps"]["coast"]["locations"]["coast.inn"].update(directions=[{}])]:
            bundle = deepcopy(original); mutate(bundle)
            with self.subTest(bundle=bundle), self.assertRaises(ValueError):
                import_story(json.dumps(bundle))

    def test_id_swaps_keep_uuid_references_and_nested_edits_preserve_extensions(self):
        project = import_story(FIXTURE.read_bytes())
        people = [page for page in project.wiki_pages if page.world.character]
        first, second = people
        for page, identity in ((first, second.world.character.character_id), (second, first.world.character.character_id)):
            sheet = replace(page.world.character, character_id=identity)
            if page.id == first.id:
                sheet = replace(sheet, bonds=page.world.character.bonds, social_profile=replace(sheet.social_profile, appearance_preferences=()))
            project.wiki_pages[project.wiki_pages.index(page)] = replace(page, world=replace(page.world, character=sheet))
        bundle, _ = export_story(project)
        self.assertEqual(bundle['characters'][0]['character_id'], 'traveller')
        self.assertEqual(bundle['characters'][0]['bonds'], {'mara': 'ally'})
        self.assertEqual(bundle['characters'][0]['social_profile']['appearance_preferences'], {})
        # Editing one location field must leave unrelated nested source extensions intact.
        page = next(p for p in project.wiki_pages if p.title == 'Lantern Inn')
        location = replace(page.world.location, description='A new description.')
        project.wiki_pages[project.wiki_pages.index(page)] = replace(page, world=replace(page.world, location=location))
        bundle, _ = export_story(project)
        self.assertEqual(bundle['maps']['coast']['locations']['coast.inn']['extra']['custom_rules'], {'moon': 'full'})

    def test_native_id_prefix_collision_is_rejected_before_output(self):
        project = import_story(FIXTURE.read_bytes())
        quay = next(p for p in project.wiki_pages if p.title == 'Quay')
        project.wiki_pages[project.wiki_pages.index(quay)] = replace(quay,
            world=replace(quay.world, location=replace(quay.world.location, location_id='inn')))
        with self.assertRaisesRegex(ValueError, 'collide'):
            export_story(project)

    def test_legacy_combat_preserves_source_and_actual_default_skills(self):
        raw = json.loads(FIXTURE.read_text())
        raw['characters'][0]['combat'] = {'hostile': True, 'might': 2}
        project = import_story(json.dumps(raw))
        self.assertEqual(export_story(project)[0], raw)
        page = next(p for p in project.wiki_pages if p.title == 'Mara Vale')
        self.assertEqual(page.world.character.combat.skills, ('second_wind',))
        sheet = replace(page.world.character, combat=replace(page.world.character.combat, might=3))
        project.wiki_pages[project.wiki_pages.index(page)] = replace(page, world=replace(page.world, character=sheet))
        combat = export_story(project)[0]['characters'][0]['combat']
        self.assertTrue(combat['hostile'])
        self.assertEqual(combat['skills'], ['second_wind'])


class FingalTransferRouteTest(unittest.TestCase):
    setUp = test_world_authoring.WorldAuthoringTest.setUp
    post = test_world_authoring.WorldAuthoringTest.post

    def call(self, path, **kwargs):
        return self.client.post('/project/fingal/' + path, headers={"X-Verwrity-Project-Id": str(self.store.get().project_id)}, **kwargs)

    def preview(self):
        return self.call('import/preview', data={"story_file": (BytesIO(FIXTURE.read_bytes()), "example.fingal.json")})

    def test_gates_and_preview_do_not_mutate_current_project(self):
        self.assertEqual(self.preview().status_code, 404)
        self.project.features = ProjectFeatures(map_editor=True, character_editor=True)
        self.assertEqual(self.preview().status_code, 404)
        self.project.features = ProjectFeatures(fingal_mode=True)
        snapshot = deepcopy(self.project)
        response = self.preview()
        self.assertEqual(response.status_code, 200, response.json)
        self.assertEqual(self.project, snapshot)
        self.assertIn('proposal', response.json)
        self.assertEqual(self.call('import/apply', json={'proposal': 'bad'}).status_code, 409)
        self.project.features = ProjectFeatures()
        self.assertEqual(self.call('import/apply', json={'proposal': response.json['proposal']}).status_code, 404)
        self.assertEqual(self.call('export/download', json={}).status_code, 404)

    def test_import_is_new_project_and_retains_old_recovery(self):
        self.project.features = ProjectFeatures(fingal_mode=True)
        self.store.commit()
        old_project, old_id = deepcopy(self.project), self.project.project_id
        proposal = self.preview().json['proposal']
        with patch.object(self.store, 'commit', side_effect=OSError('private')):
            self.assertEqual(self.call('import/apply', json={'proposal': proposal}).status_code, 503)
        self.assertEqual(self.store.get(), old_project)
        response = self.call('import/apply', json={'proposal': proposal})
        self.assertEqual(response.status_code, 200, response.json)
        imported = self.store.get()
        self.assertNotEqual(imported.project_id, old_id)
        self.assertEqual(imported.scenes, [])
        self.assertEqual(self.store.drafts.latest(old_id).project, old_project)
        self.assertEqual(self.store.drafts.latest(imported.project_id).project, imported)
        library = self.app.config['PROJECT_LIBRARY']
        duplicate = library.load('local-user', library.duplicate('local-user', imported, 'World copy').name)
        self.assertEqual(duplicate.fingal_source, imported.fingal_source)
        self.assertEqual(duplicate.wiki_pages, imported.wiki_pages)
        self.assertNotEqual(duplicate.project_id, imported.project_id)
        self.assertEqual(self.call('import/apply', json={'proposal': proposal}).status_code, 409)
        sheet = next(p for p in imported.wiki_pages if p.world.character)
        self.project = imported
        data = record_data(sheet.world.character); data['age'] = 45
        self.assertEqual(self.post(f'/world/pages/{sheet.id}', {'kind': 'character', 'page_hash': page_hash(sheet), 'record': data}).status_code, 200)
        updated = next(p for p in imported.wiki_pages if p.id == sheet.id)
        self.assertEqual(updated.world.source.edited_fields, ('age',))
        self.assertEqual(updated.revisions[-1].world, sheet.world)

    def test_export_requires_review_and_rejects_changes_after_review(self):
        self.store.replace(import_story(FIXTURE.read_bytes()))
        self.project = self.store.get()
        proposal = self.call('export/preview', json={}).json['proposal']
        response = self.call('export/download', json={'proposal': proposal})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(json.loads(response.data), json.loads(FIXTURE.read_text()))
        self.project.maps[0] = replace(self.project.maps[0], title='Renamed')
        self.assertEqual(self.call('export/download', json={'proposal': proposal}).status_code, 409)
        self.store.replace(StoryProject('Empty', features=ProjectFeatures(fingal_mode=True)))
        report = self.call('export/preview', json={}).json
        self.assertTrue(report['errors'])
        self.assertNotIn('proposal', report)
