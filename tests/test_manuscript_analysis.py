import json
import tempfile
import unittest
from copy import deepcopy
from dataclasses import replace
from pathlib import Path
from uuid import uuid4

from verwrity.ai.llm import LLMRegistry
from verwrity.ai.settings import UserAISettings
from verwrity.domain.story import Scene, StoryProject
from verwrity.project.store import ProjectStore
from verwrity.web.app import create_app


class ManuscriptReviewTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.app = create_app(ProjectStore(StoryProject.demo()))
        self.app.config["PROJECT_DRAFT_ROOT"] = Path(self.directory.name) / ".drafts"
        self.app.config["PROJECT_LIBRARY"].root = Path(self.directory.name)
        self.app.extensions["ai_settings"] = UserAISettings(Path(self.directory.name))
        self.client = self.app.test_client()
        self.client.get("/")
        self.project = next(iter(self.app.config["PROJECT_STORES"].values())).get()
        self.project.scenes = [Scene(id=uuid4(), title=f"Scene {i}", text=f"Distinct narration in scene {i}.")
                               for i in range(4)]
        historical = Scene(id=uuid4(), title="Removed scene", text="HISTORICAL SECRET", historical=True)
        self.project.scenes.append(historical)
        self.project.wiki_pages[0] = replace(self.project.wiki_pages[0], body="WIKI SECRET")
        with self.client.session_transaction() as session:
            session["active_scene_id"] = str(self.project.scenes[2].id)

        project = self.project

        class FakeLLM:
            standard_id = "openai_compatible"
            display_name = "fake"
            default_endpoint = "http://localhost:8081/v1"

            def __init__(self):
                self.prompts = []

            def complete(self, endpoint, model, token, prompt):
                self.prompts.append(prompt)
                return json.dumps({"answer": "Compare the narration in Scene 0 and Scene 3.", "evidence": [
                    {"source_type": "scene", "source_id": str(scene.id), "quote": scene.text}
                    for scene in [project.scenes[0], project.scenes[3], historical]
                ] + [
                    {"source_type": "wiki", "source_id": str(project.wiki_pages[0].id), "quote": "WIKI SECRET"},
                    {"source_type": "scene", "source_id": str(project.scenes[0].id), "quote": "Invented words"},
                ]})

            def stream(self, *args):
                yield self.complete(*args)

        self.fake = FakeLLM()
        self.app.extensions["llm_registry"] = LLMRegistry([self.fake])
        self.app.extensions["ai_settings"].update_llm("local-user", {
            "endpoint": "http://localhost:8081/v1", "model": "fake",
        }, self.app.extensions["llm_registry"])

    def test_review_covers_current_manuscript_independently_of_qa_and_preserves_project(self):
        original = deepcopy(self.project)
        for endpoint in ["/ai/ask", "/ai/ask/stream"]:
            with self.subTest(endpoint=endpoint):
                response = self.client.post(endpoint, json={
                    "task_id": "narrative_voice", "question": "OVERRIDE SECRET",
                    "before_percent": 0, "after_percent": 0, "include_wiki": True,
                    "history": [{"question": "HISTORY SECRET", "answer": "OLD ANSWER"}],
                })
                self.assertEqual(response.status_code, 200)
                if endpoint.endswith("stream"):
                    events = [json.loads(block.removeprefix("data: "))
                              for block in response.get_data(as_text=True).strip().split("\n\n")]
                    self.assertEqual(events[0]["scene_count"], 4)
                    self.assertEqual(events[0]["wiki_count"], 0)
                    result = events[-1]["result"]
                else:
                    result = response.get_json()
                self.assertEqual([item["source_id"] for item in result["evidence"]],
                                 [str(self.project.scenes[i].id) for i in [0, 3]])
                prompt = self.fake.prompts[-1]
                for scene in self.project.current_scenes():
                    self.assertIn(scene.text, prompt)
                for excluded in ["HISTORICAL SECRET", "WIKI SECRET", "HISTORY SECRET", "OVERRIDE SECRET"]:
                    self.assertNotIn(excluded, prompt)
                self.assertIn("consistency does not mean uniformity", prompt)
                self.assertIn("cross-scene consistency cannot", prompt)
                self.assertEqual(self.project, original)

    def test_unknown_tasks_and_empty_manuscript_do_not_call_provider(self):
        for task_id in ["missing", None, [], {}]:
            for endpoint in ["/ai/ask", "/ai/ask/stream"]:
                self.assertEqual(self.client.post(endpoint, json={"task_id": task_id}).status_code, 400)
        for scene in self.project.current_scenes():
            scene.text = "   "
        response = self.client.post("/ai/ask/stream", json={"task_id": "narrative_voice"})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.fake.prompts, [])

    def test_review_requires_consent_for_exact_remote_endpoint(self):
        settings = self.app.extensions["ai_settings"]
        configured = settings.load("local-user")["llm"]
        configured.update(endpoint="https://example.test/v1", remote_consent_endpoint="https://other.test/v1")
        settings._save("local-user", "llm", configured)
        for endpoint in ["/ai/ask", "/ai/ask/stream"]:
            self.assertEqual(self.client.post(endpoint, json={"task_id": "narrative_voice"}).status_code, 403)
        self.assertEqual(self.fake.prompts, [])

    def test_menu_exposes_task_without_running_it_on_load(self):
        html = self.client.get("/").get_data(as_text=True)
        self.assertIn('data-manuscript-task="narrative_voice"', html)
        self.assertEqual(self.fake.prompts, [])
