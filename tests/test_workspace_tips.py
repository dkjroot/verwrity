"""Workspace cards are editorial UI, never canonical project data."""

from copy import deepcopy
from html.parser import HTMLParser
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from verwrity.domain.story import StoryProject
from verwrity.project.library import ProjectLibrary
from verwrity.project.store import ProjectStore
from verwrity.web.app import create_app
from verwrity.web.services.workspace_tips import TIPS, support_links, workspace_tips


class HelpStructure(HTMLParser):
    def __init__(self):
        super().__init__()
        self.targets = {}
        self.local_links = set()
        self.duplicates = set()
        self.topic_text = {}
        self.active_topic = None
        self.ocr_duplicate_default = None

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if "data-ocr-duplicate-threshold" in attrs:
            self.ocr_duplicate_default = attrs.get("value")
        if tag == "article" and "id" in attrs:
            self.active_topic = attrs["id"]
            self.topic_text[self.active_topic] = []
        if "id" in attrs:
            if attrs["id"] in self.targets:
                self.duplicates.add(attrs["id"])
            self.targets[attrs["id"]] = attrs
        if tag == "a" and attrs.get("href", "").startswith("#"):
            self.local_links.add(attrs["href"][1:])

    def handle_data(self, data):
        if self.active_topic:
            self.topic_text[self.active_topic].append(data)

    def handle_endtag(self, tag):
        if tag == "article":
            self.active_topic = None


class WorkspaceTipsTest(unittest.TestCase):
    def test_default_support_is_only_the_developers_coffee_link(self):
        with patch.dict("os.environ", {}, clear=True), TemporaryDirectory() as directory:
            app = create_app(ProjectStore(StoryProject.demo()))
            app.config["PROJECT_LIBRARY"] = ProjectLibrary(Path(directory))
            app.config["PROJECT_DRAFT_ROOT"] = Path(directory) / ".drafts"
            self.assertEqual([(link.label, link.url) for link in support_links(app.config)],
                             [("Buy Me a Coffee", "https://buymeacoffee.com/dkjroot")])
            client = app.test_client()
            for path in ("/", "/help"):
                with self.subTest(path=path):
                    html = client.get(path).get_data(as_text=True)
                    self.assertIn('href="https://buymeacoffee.com/dkjroot"', html)
                    self.assertNotIn("Patreon", html)
                    self.assertNotIn("Kickstarter", html)
            app.config["SUPPORT_COFFEE_URL"] = ""
            html = client.get("/help").get_data(as_text=True)
            self.assertNotIn("Buy me a coffee", html)
            self.assertNotIn('class="help-support-links"', html)

    def test_deck_has_three_hints_between_support_cards(self):
        deck = workspace_tips({})
        self.assertGreaterEqual(len(TIPS), 3)
        self.assertEqual(len(deck), len(TIPS) + len(TIPS) // 3)
        self.assertEqual(tuple(tip for tip in deck if tip.kind == "tip"), TIPS)
        for index, tip in enumerate(deck):
            expected_kind = "support" if (index + 1) % 4 == 0 else "tip"
            self.assertEqual(tip.kind, expected_kind)
        self.assertTrue(all(not tip.links for tip in deck))

    def test_help_covers_current_workflows_with_valid_accessible_topic_links(self):
        # Topic contracts keep newly exposed capabilities discoverable from Help,
        # including recovery/privacy decisions that cannot be inferred from icons.
        required = {"getting-started", "storyboard", "manuscript", "find-replace",
                    "focus", "wiki", "scene-metadata", "comments", "revisions",
                    "analysis", "dictionaries", "ai-models", "questions", "tasks",
                    "read-aloud", "dictation", "projects", "recovery", "privacy",
                    "shortcuts", "troubleshooting", "support",
                    "dialogue", "scene-structure", "wiki-ai", "project-features",
                    "world-authoring", "fingal-transfer", "dictate-draft",
                    "ocr-import", "speed-reader", "project-words"}
        app = create_app()
        html = app.test_client().get("/help").get_data(as_text=True)
        structure = HelpStructure()
        structure.feed(html)
        self.assertFalse(structure.duplicates)
        self.assertTrue(required <= structure.local_links)
        self.assertTrue(structure.local_links <= structure.targets.keys())
        for topic in structure.local_links:
            with self.subTest(topic=topic):
                self.assertEqual(structure.targets[topic].get("tabindex"), "-1")

    def test_import_and_reading_help_explains_review_recovery_and_privacy(self):
        app = create_app()
        structure = HelpStructure()
        structure.feed(app.test_client().get("/help").get_data(as_text=True))
        # Check important choices in their own discoverable topics, rather than
        # accepting a passing mention somewhere on a very long Help page.
        controls = {
            "dictation": ("Right Ctrl", "five minutes", "microphone"),
            "dictate-draft": ("Import audio file", "24 MiB", "Use reviewed cleanup",
                              "Insert approved sections", "Clear recordings"),
            "ocr-import": ("Show unchecked thumbnails", "Online OCR sends", "raw", "LLM"),
            "speed-reader": ("Space", "Escape", "Flash (ms)", "Repeats", "flashing"),
            "project-words": ("Scan saved manuscript", "Create wiki pages and add selected words"),
        }
        for topic, phrases in controls.items():
            with self.subTest(topic=topic):
                text = " ".join(structure.topic_text[topic])
                for phrase in phrases:
                    self.assertIn(phrase, text)
        self.assertTrue({"dictation", "dictate-draft", "ocr-import", "speed-reader"}
                        <= {tip.help_topic for tip in TIPS})
        workspace = HelpStructure()
        workspace.feed(app.test_client().get("/").get_data(as_text=True))
        self.assertIsNotNone(workspace.ocr_duplicate_default)
        self.assertIn(f"{workspace.ocr_duplicate_default}% by default",
                      " ".join(structure.topic_text["ocr-import"]))

    def test_every_tip_has_a_matching_local_help_topic(self):
        with TemporaryDirectory() as directory:
            app = create_app(ProjectStore(StoryProject.demo()))
            app.config["PROJECT_LIBRARY"] = ProjectLibrary(Path(directory))
            app.config["PROJECT_DRAFT_ROOT"] = Path(directory) / ".drafts"
            client = app.test_client()
            help_html = client.get("/help").get_data(as_text=True)
            workspace_html = client.get("/").get_data(as_text=True)
            for tip in workspace_tips({}):
                with self.subTest(tip=tip.title):
                    self.assertTrue(tip.help_topic)
                    self.assertIn(f'id="{tip.help_topic}"', help_html)
                    self.assertIn(f'href="#{tip.help_topic}"', help_html)
                    self.assertIn(f'data-help-url="/help#{tip.help_topic}"', workspace_html)
            self.assertTrue(all(tip.help_topic == "support" for tip in workspace_tips({}) if tip.kind == "support"))

    def test_help_uses_only_configured_safe_support_links(self):
        app = create_app()
        client = app.test_client()
        app.config.update(SUPPORT_PATREON_URL="", SUPPORT_COFFEE_URL="", SUPPORT_KICKSTARTER_URL="")
        with patch.object(ProjectStore, "commit") as commit:
            html = client.get("/help").get_data(as_text=True)
            commit.assert_not_called()
        self.assertIn('id="support"', html)
        self.assertNotIn('class="help-support-links"', html)
        self.assertNotIn("Offer regular support", html)
        self.assertNotIn("Back a campaign", html)
        app.config.update(SUPPORT_COFFEE_URL="https://buymeacoffee.com/example?test=a&other=b",
                          SUPPORT_PATREON_URL="javascript:alert(1)",
                          SUPPORT_KICKSTARTER_URL="https://user:secret@example.com")
        html = client.get("/help").get_data(as_text=True)
        self.assertIn('https://buymeacoffee.com/example?test=a&amp;other=b', html)
        self.assertIn('target="_blank" rel="noopener noreferrer"', html)
        self.assertNotIn('javascript:alert', html)
        self.assertNotIn('user:secret', html)
        self.assertIn("Buy me a coffee", html)
        self.assertNotIn("Patreon", html)
        self.assertNotIn("Kickstarter", html)

    def test_support_links_are_optional_explicit_https_urls(self):
        config = {"SUPPORT_PATREON_URL": "https://www.patreon.com/example",
                  "SUPPORT_COFFEE_URL": "https://buymeacoffee.com/example",
                  "SUPPORT_KICKSTARTER_URL": "https://www.kickstarter.com/projects/example/book"}
        self.assertEqual([link.label for link in support_links(config)], ["Patreon", "Buy Me a Coffee", "Kickstarter"])
        for invalid in ("javascript:alert(1)", "http://example.com", "https://", "https://user:secret@example.com",
                        "https://example.com:bad", "https://example.com/\npath", "https://[broken"):
            with self.subTest(url=invalid):
                self.assertEqual(support_links({"SUPPORT_PATREON_URL": invalid}), ())

    def test_rendering_tips_never_changes_project_or_saves_a_draft(self):
        project = StoryProject.demo()
        before = deepcopy(project)
        with TemporaryDirectory() as directory:
            app = create_app(ProjectStore(project))
            app.config["PROJECT_LIBRARY"] = ProjectLibrary(Path(directory))
            app.config["PROJECT_DRAFT_ROOT"] = Path(directory) / ".drafts"
            app.config["SUPPORT_PATREON_URL"] = "https://www.patreon.com/example?test=a&other=b"
            app.config["SUPPORT_COFFEE_URL"] = "javascript:alert(1)"
            app.config["SUPPORT_KICKSTARTER_URL"] = ""
            client = app.test_client()
            with patch.object(ProjectStore, "commit") as commit:
                response = client.get("/")
                self.assertEqual(response.status_code, 200)
                commit.assert_not_called()
            html = response.get_data(as_text=True)
            self.assertIn('data-workspace-tips hidden', html)
            self.assertIn('https://www.patreon.com/example?test=a&amp;other=b', html)
            self.assertNotIn('javascript:alert', html)
            self.assertIn('rel="noopener noreferrer"', html)
            self.assertEqual(next(iter(app.config["PROJECT_STORES"].values())).get(), before)
            self.assertFalse(Path(app.config["PROJECT_DRAFT_ROOT"]).exists())

    def test_recovery_choice_retains_the_same_project_and_tips(self):
        project = StoryProject.demo()
        project.title = "Recovered writing day"
        with TemporaryDirectory() as directory:
            root = Path(directory)
            from verwrity.project.drafts import DraftRepository
            DraftRepository(root, "local-user").save(project, None)
            app = create_app()
            app.config["PROJECT_LIBRARY"] = ProjectLibrary(root)
            app.config["PROJECT_DRAFT_ROOT"] = root
            client = app.test_client()
            before_choice = client.get("/").get_data(as_text=True)
            self.assertIn("data-recovery-dialog", before_choice)
            self.assertIn("data-workspace-tips hidden", before_choice)
            response = client.post("/project/recovery/continue", follow_redirects=True)
            self.assertEqual(response.status_code, 200)
            after_choice = response.get_data(as_text=True)
            self.assertNotIn("data-recovery-dialog", after_choice)
            self.assertIn("data-workspace-tips hidden", after_choice)
            self.assertEqual(next(iter(app.config["PROJECT_STORES"].values())).get(), project)


if __name__ == "__main__":
    unittest.main()
