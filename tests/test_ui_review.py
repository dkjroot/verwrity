"""Regression coverage for the UI review's explicit data-changing actions."""
from copy import deepcopy
from uuid import uuid4
from unittest import TestCase
from pathlib import Path
from tempfile import TemporaryDirectory
from verwrity.project.library import ProjectLibrary
from verwrity.project.store import ProjectStore
from verwrity.web.app import create_app
from verwrity.domain.dialogue import DialogueAttribution, dialogue_rows
from verwrity.domain.story import StoryProject, WikiPage
from verwrity.project.preferences import UserPreferences


class UIReviewRoutes(TestCase):
    def setUp(self):
        temp = TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        project = StoryProject.demo()
        project.scenes[0].text = "Canonical prose remains untouched."
        self.app = create_app(ProjectStore(project))
        self.app.config.update(TESTING=True, PROJECT_DRAFT_ROOT=self.root / "drafts",
                               PROJECT_LIBRARY=ProjectLibrary(self.root))
        self.client = self.app.test_client()
        self.client.get("/")
        self.store = next(iter(self.app.config['PROJECT_STORES'].values()))
        self.app.extensions['user_preferences'] = UserPreferences(self.root)

    def test_bulk_user_words_are_validated_stale_safe_and_separate_from_project(self):
        project = deepcopy(self.store.get())
        response = self.client.post('/spelling-dictionary/global', json={'words': ['Moonwyrm', 'starling'], 'previous': []})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json['words'], ['moonwyrm', 'starling'])
        self.assertEqual(self.store.get(), project)
        self.assertEqual(self.client.post('/spelling-dictionary/global', json={'words': [], 'previous': []}).status_code, 409)
        self.assertEqual(self.client.post('/spelling-dictionary/global', json={'words': ['two words'], 'previous': response.json['words']}).status_code, 400)
        self.assertEqual(self.client.get('/spelling-dictionary/global').json['words'], ['moonwyrm', 'starling'])

    def test_shared_manager_consolidates_legacy_dictionary_only_on_explicit_save(self):
        self.store.get().spelling_dictionary.add('moonwyrm')
        self.store.commit()
        state = self.client.get('/project/words').json
        self.assertIn('moonwyrm', state['dictionary'])
        saved = self.client.post('/project/words', json={'project_id': state['project_id'], 'version': state['version'], 'words': ['moonwyrm'], 'replace_dictionary': True})
        self.assertEqual(saved.status_code, 200)
        self.assertEqual(self.store.get().spelling_dictionary, set())
        self.assertIn('moonwyrm', self.store.get().project_words)
        self.assertEqual(self.client.post('/project/words', json={'project_id': state['project_id'], 'version': state['version'], 'words': []}).status_code, 409)

    def test_sticky_note_title_edits_preserve_identity_and_prose(self):
        project = self.store.get(); scene = project.current_scenes()[0]; before = deepcopy(scene)
        response = self.client.post('/storyboard/save', data={'scene_id': [str(s.id) for s in project.current_scenes()], f'title_{scene.id}': 'A new title'})
        self.assertEqual(response.status_code, 302)
        current = self.store.get().scene(before.id)
        self.assertEqual(current.title, 'A new title')
        self.assertEqual(current.text, before.text)
        self.assertEqual(current.metadata, before.metadata)

    def test_find_ranges_are_exact_unicode_offsets_and_never_change_prose(self):
        project = self.store.get(); scene = project.current_scenes()[0]
        scene.text = '😀 Needle α. Needle β.'
        with self.client.session_transaction() as session:
            session['active_scene_id'] = str(scene.id)
        before = deepcopy(project)
        response = self.client.post('/manuscript/search', json={'query': 'needle', 'scope': 'current_scene',
            'active_text': scene.text, 'include_ranges': True})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json['matches'][0]['ranges'], [
            {'start': 2, 'end': 8, 'quote': 'Needle'}, {'start': 12, 'end': 18, 'quote': 'Needle'}])
        self.assertEqual(project, before)


class DialogueDisplay(TestCase):
    def test_display_adds_only_existing_adjacent_punctuation_without_changing_anchor(self):
        project = StoryProject.demo(); scene = project.current_scenes()[0]
        page = WikiPage(uuid4(), 'Mara'); project.wiki_pages.append(page)
        scene.text = 'Mara said, “Thanks!” Then left.'
        start = scene.text.index('Thanks'); scene.dialogue = [DialogueAttribution(uuid4(), page.id, start, start + 6, 'Thanks', 'Thanks')]
        row = dialogue_rows(project, page.id)[0]
        self.assertEqual(row['display_quote'], '“Thanks!”')
        self.assertEqual(row['quote'], 'Thanks')
        self.assertEqual(row['start'], start)
        scene.text = "Mara said, 'Thanks!' Then left."; start = scene.text.index('Thanks')
        scene.dialogue = [DialogueAttribution(uuid4(), page.id, start, start + 6, 'Thanks', 'Thanks')]
        self.assertEqual(dialogue_rows(project, page.id)[0]['display_quote'], "'Thanks!'")
        scene.text = 'Mara said, Thanks Then left.'; start = scene.text.index('Thanks')
        scene.dialogue = [DialogueAttribution(uuid4(), page.id, start, start + 6, 'Thanks', 'Thanks')]
        self.assertEqual(dialogue_rows(project, page.id)[0]['display_quote'], 'Thanks')
