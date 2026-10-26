import unittest
from tempfile import TemporaryDirectory
from pathlib import Path
from uuid import uuid4

from verwrity.analysis.spelling import SpellChecker
from verwrity.domain.story import StoryProject
from verwrity.project.store import ProjectStore
from verwrity.project.preferences import UserPreferences
from verwrity.project.archive import export_project, import_project
from verwrity.web.app import create_app


class SpellCheckerTest(unittest.TestCase):
    def test_hyphenated_compounds_accept_valid_parts_but_retain_typo_evidence(self):
        checker = SpellChecker(words=["chicken", "feed", "mother", "in", "law"])
        text = "😀 Chicken-feed mother-in-law chicken‐feed chicken‑feed chicken-fead Zorvanna-feed"
        result = checker.analyze(uuid4(), text, ["zorvanna"])
        self.assertEqual([item.word for item in result.annotations], ["chicken-fead"])
        for item in result.annotations:
            self.assertEqual(text[item.start:item.end], item.word)

    def test_bundled_dictionary_accepts_supported_dialects_and_current_vocabulary(self):
        checker = SpellChecker()
        words = (
            "colour color centre center favourite favorite organise organize "
            "recognise recognize manoeuvre maneuver theatre theater judgement judgment "
            "colouring coloring travelling traveling cancelled canceled "
            "acknowledgement acknowledgment aeroplane airplane cheque check "
            "neurodivergent lockdown livestream selfie emoji liminal "
            "the because children mice went written kiev reactance trabecula"
        ).split()
        for word in words:
            with self.subTest(word=word):
                self.assertTrue(checker.is_correct(word))
        self.assertEqual(checker.analyze(uuid4(), " ".join(words)).annotations, ())

    def test_updated_dictionary_retains_typo_detection_offsets_and_author_additions(self):
        checker = SpellChecker()
        text = "😀 Colour, centre and favourites.\n\nZorvanna's recieve teh definately seperate accomodate."
        result = checker.analyze(uuid4(), text, ["zorvanna"])
        self.assertEqual([item.word for item in result.annotations], ["recieve", "teh", "definately", "seperate", "accomodate"])
        for finding in result.annotations:
            self.assertEqual(text[finding.start:finding.end], finding.word)
        self.assertIn("receive", result.annotations[0].suggestions)

    def test_bundled_source_is_reproducible_normalized_and_carries_full_notices(self):
        from hashlib import sha256
        from verwrity.analysis import spelling
        data = Path(spelling.__file__).with_name("data")
        raw = (data / "english_words.txt").read_bytes()
        words = raw.decode("utf-8").splitlines()
        self.assertEqual(words, sorted(set(words)))
        self.assertTrue(all(spelling.WORD_RE.fullmatch(word) and word == word.casefold() for word in words))
        self.assertNotIn(b"\r", raw)
        provenance = (data / "SPELLING_SOURCE.txt").read_text(encoding="utf-8")
        self.assertIn(f"Generated SHA-256: {sha256(raw).hexdigest()}", provenance)
        self.assertIn(f"Generated entries: {len(words)}", provenance)
        licence = (data / "SCOWL_LICENSE.txt").read_text(encoding="utf-8")
        self.assertIn("Copyright 2000-2026 by Kevin Atkinson", licence)
        self.assertIn("Copyright 2016 by Benjamin Titze", licence)
        self.assertIn('provided "as is"', licence.lower())

    def test_manuscript_preferences_are_validated_and_saved_outside_project(self):
        with TemporaryDirectory() as directory:
            preferences = UserPreferences(Path(directory))
            saved = preferences.update("local-user", "manuscript", {
                "font_family": "serif", "font_size": 20,
                "text_color": "#123ABC", "background_color": "#fefefe",
            })

            self.assertEqual(saved, {
                "font_family": "serif", "font_size": 20,
                "text_color": "#123abc", "background_color": "#fefefe",
            })
            self.assertEqual(preferences.load("local-user")["manuscript"], saved)
            with self.assertRaises(ValueError):
                preferences.update("local-user", "manuscript", {"font_size": 999})
            with self.assertRaises(ValueError):
                preferences.update("local-user", "manuscript", {"text_color": "red"})

    def test_comment_appearance_defaults_legacy_settings_and_user_isolation(self):
        import json
        with TemporaryDirectory() as directory:
            preferences = UserPreferences(Path(directory))
            self.assertEqual(preferences.load("local-user")["comments"],
                             {"enabled": False, "style": "underline", "color": "#8b72c7"})
            path = Path(directory) / "local-user" / "preferences.json"
            path.parent.mkdir()
            path.write_text(json.dumps({"version": 1, "comments": {"enabled": True}}))
            self.assertEqual(preferences.load("local-user")["comments"]["style"], "underline")
            saved = preferences.update("local-user", "comments", {"style": "highlight", "color": "#aAbBcC"})
            self.assertEqual(saved, {"enabled": True, "style": "highlight", "color": "#aabbcc"})
            self.assertEqual(UserPreferences(directory).load("local-user")["comments"], saved)
            self.assertFalse(preferences.load("other-user")["comments"]["enabled"])
            for invalid in ({"color": "red"}, {"style": "dotted"}):
                with self.assertRaises(ValueError):
                    preferences.update("local-user", "comments", invalid)

    def test_manuscript_preferences_endpoint_persists_display_only_choices(self):
        project = StoryProject.demo()
        app = create_app(ProjectStore(project))
        with TemporaryDirectory() as directory:
            app.config["PROJECT_DRAFT_ROOT"] = Path(directory) / ".drafts"
            app.extensions["user_preferences"] = UserPreferences(Path(directory))
            client = app.test_client()

            response = client.post("/preferences/manuscript", json={"font_family": "serif", "font_size": 18})

            self.assertEqual(response.status_code, 200)
            self.assertEqual(client.get("/preferences/manuscript").json["font_family"], "serif")
            self.assertEqual(client.get("/preferences/manuscript").json["font_size"], 18)
            self.assertEqual(project.scenes[0].text, StoryProject.demo().scenes[0].text)

    def test_annotations_have_offsets_and_suggestions_without_changing_text(self):
        checker = SpellChecker(words=["the", "quick", "fox", "receive"])
        scene_id = uuid4()
        text = "The quik fox recieve."

        result = checker.analyze(scene_id, text)

        self.assertEqual([(item.word, item.start, item.end) for item in result.annotations], [
            ("quik", 4, 8),
            ("recieve", 13, 20),
        ])
        self.assertIn("quick", result.annotations[0].suggestions)
        self.assertIn("receive", result.annotations[1].suggestions)
        self.assertEqual(text, "The quik fox recieve.")

    def test_endpoint_analyzes_submitted_text_without_mutating_scene(self):
        project = StoryProject.demo()
        original = project.scenes[0].text
        app = create_app(ProjectStore(project))
        with TemporaryDirectory() as directory:
            app.config["PROJECT_DRAFT_ROOT"] = Path(directory) / ".drafts"
            app.extensions["user_preferences"] = UserPreferences(Path(directory))
            client = app.test_client()

            response = client.post(
                f"/scene/{project.scenes[0].id}/spell-check",
                data={"scene_text": "The quik fox."},
            )

            self.assertEqual(response.status_code, 200)
            self.assertEqual([item["word"] for item in response.json["annotations"]], ["quik"])
            store = next(iter(app.config["PROJECT_STORES"].values()))
            self.assertEqual(store.get().scenes[0].text, original)

    def test_endpoint_offsets_match_lf_text_after_form_line_endings(self):
        project = StoryProject.demo()
        app = create_app(ProjectStore(project))
        text = "The quik fox.\n\nThe recieve."
        with TemporaryDirectory() as directory:
            app.config["PROJECT_DRAFT_ROOT"] = Path(directory) / ".drafts"
            app.extensions["user_preferences"] = UserPreferences(Path(directory))
            client = app.test_client()

            response = client.post(
                f"/scene/{project.scenes[0].id}/spell-check",
                data={"scene_text": text.replace("\n", "\r\n")},
            )

            self.assertEqual(response.status_code, 200)
            self.assertEqual(
                [(item["word"], item["start"], item["end"]) for item in response.json["annotations"]],
                [("quik", text.index("quik"), text.index("quik") + 4),
                 ("recieve", text.index("recieve"), text.index("recieve") + 7)],
            )

    def test_common_inflections_and_possessives_are_recognized(self):
        checker = SpellChecker(words=["story", "fox", "writer", "try", "walk", "make", "run", "city"])
        text = "stories foxes writer's writers' tried walking making runs cities"
        self.assertTrue(all(checker.is_correct(word) for word in text.split()))
        self.assertEqual(checker.analyze(uuid4(), text).annotations, ())

    def test_custom_dictionary_words_accept_inflections(self):
        checker = SpellChecker(words=["the", "quik"])
        result = checker.analyze(uuid4(), "Quik's quiks quikly.", ["quik"])
        self.assertEqual([item.word for item in result.annotations], ["quikly"])

    def test_dictionaries_persist_in_user_storage_and_project_archive(self):
        with TemporaryDirectory() as directory:
            preferences = UserPreferences(Path(directory))
            self.assertEqual(preferences.update_spelling_dictionary("local-user", "Mara"), ["mara"])
            self.assertEqual(preferences.spelling_dictionary("local-user"), ["mara"])
            preferences.update_spelling_dictionary("local-user", "Mara", remove=True)
            self.assertEqual(preferences.spelling_dictionary("local-user"), [])

        project = StoryProject.demo()
        project.spelling_dictionary.add("quik")
        _, archive = export_project(project)
        self.assertEqual(import_project(archive).spelling_dictionary, {"quik"})

    def test_dictionary_endpoints_are_scoped_and_spell_check_uses_both(self):
        project = StoryProject.demo()
        original = project.scenes[0].text
        app = create_app(ProjectStore(project))
        with TemporaryDirectory() as directory:
            app.config["PROJECT_DRAFT_ROOT"] = Path(directory) / ".drafts"
            app.extensions["user_preferences"] = UserPreferences(Path(directory))
            client = app.test_client()
            self.assertEqual(client.post("/spelling-dictionary/global", json={"word": "Mara"}).status_code, 200)
            self.assertEqual(client.post("/spelling-dictionary/project", json={"word": "Xanadu"}).status_code, 200)
            recovered_draft = import_project(next((Path(directory) / ".drafts").rglob("current.verwrity.zip")).read_bytes())
            self.assertEqual(recovered_draft.spelling_dictionary, {"xanadu"})
            result = client.post(
                f"/scene/{project.scenes[0].id}/spell-check",
                data={"scene_text": "Mara met Xanadu and quik."},
            )
            self.assertEqual([item["word"] for item in result.json["annotations"]], ["quik"])
            self.assertEqual(client.post("/spelling-dictionary/global", json={"word": "not a word"}).status_code, 400)
            self.assertEqual(client.get("/spelling-dictionary/unknown").status_code, 404)
            self.assertEqual(project.scenes[0].text, original)
