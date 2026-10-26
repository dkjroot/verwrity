"""Selected-passage Q&A scope, exact evidence and stale-source boundaries."""

from copy import deepcopy
from hashlib import sha256
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from verwrity.ai.interrogation import prepare_alternatives
from verwrity.ai.llm import LLMRegistry
from verwrity.ai.settings import UserAISettings
from verwrity.domain.scene_metadata import SceneMetadata
from verwrity.domain.story import StoryProject
from verwrity.project.library import ProjectLibrary
from verwrity.project.preferences import UserPreferences
from verwrity.project.store import ProjectStore
from verwrity.project.text_analysis import UserTextAnalyses
from verwrity.web.app import create_app


class SelectedQuestionContextTest(unittest.TestCase):
    def setUp(self):
        self.directory = TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        root = Path(self.directory.name)
        project = StoryProject.demo()
        self.quote = "The same 😀 sentence.\nA second line."
        project.scenes[0].text = self.quote + "\n\nPRIVATE BEFORE.\n\n" + self.quote + "\n\nPRIVATE AFTER."
        project.scenes[0].metadata = SceneMetadata(voice_notes="PRIVATE METADATA")
        project.scenes[1].text = "PRIVATE OTHER SCENE."
        project.scenes[2].historical = True
        self.app = create_app(ProjectStore(project))
        self.app.config.update(TESTING=True, PROJECT_LIBRARY=ProjectLibrary(root), PROJECT_DRAFT_ROOT=root / "drafts")
        self.app.extensions["ai_settings"] = UserAISettings(root)
        self.app.extensions["user_preferences"] = UserPreferences(root)
        self.app.extensions["text_analyses"] = UserTextAnalyses(root)
        self.client = self.app.test_client()
        self.client.get("/")
        self.store = next(iter(self.app.config["PROJECT_STORES"].values()))
        self.scene = self.store.get().scenes[0]
        self.prompts = []
        owner = self

        class FakeLLM:
            standard_id = "openai_compatible"
            display_name = "Test local model"
            default_endpoint = "http://localhost:8081/v1"

            def complete(self, endpoint, model, token, prompt):
                owner.prompts.append(prompt)
                return json.dumps({"answer": "Read the selected sentence.", "evidence": [
                    {"source_type": "scene", "source_id": str(owner.scene.id), "quote": owner.quote},
                    {"source_type": "scene", "source_id": str(owner.scene.id), "quote": "PRIVATE BEFORE."},
                    {"source_type": "scene", "source_id": str(owner.scene.id), "quote": owner.quote + "\n\nPRIVATE AFTER."},
                    {"source_type": "wiki", "source_id": str(owner.store.get().wiki_pages[0].id), "quote": owner.store.get().wiki_pages[0].body},
                ]})

            def stream(self, *args):
                yield self.complete(*args)

        self.app.extensions["llm_registry"] = LLMRegistry([FakeLLM()])
        self.settings = self.app.extensions["ai_settings"]
        self.settings.update_llm("local-user", {"standard": "openai_compatible", "endpoint": "http://localhost:8081/v1", "model": "test"}, self.app.extensions["llm_registry"])

    def selection(self):
        start = self.scene.text.rindex(self.quote)
        return {"project_id": str(self.store.get().project_id), "scene_id": str(self.scene.id),
                "start": start, "end": start + len(self.quote), "quote": self.quote,
                "source_hash": sha256(self.scene.text.encode("utf-8")).hexdigest()}

    def payload(self):
        return {"question": "What does this sentence convey?", "context_mode": "selection",
                "selected_context": self.selection(), "before_percent": 100, "after_percent": 100,
                "include_wiki": True, "history": [{"question": "PRIVATE QUESTION", "answer": "PRIVATE ANSWER"}]}

    def test_only_selection_reaches_provider_and_citations_keep_second_occurrence(self):
        original = deepcopy(self.store.get())
        for endpoint in ("/ai/ask", "/ai/ask/stream"):
            with self.subTest(endpoint=endpoint):
                response = self.client.post(endpoint, json=self.payload())
                self.assertEqual(response.status_code, 200)
                if endpoint.endswith("stream"):
                    events = [json.loads(line[6:]) for line in response.get_data(as_text=True).splitlines() if line.startswith("data: ")]
                    status = next(item for item in events if item["type"] == "status")
                    self.assertEqual((status["scene_count"], status["wiki_count"]), (1, 0))
                    result = next(item["result"] for item in events if item["type"] == "result")
                else:
                    result = response.json
                self.assertEqual(len(result["evidence"]), 1)
                self.assertEqual(result["evidence"][0]["start"], self.selection()["start"])
                self.assertEqual(result["evidence"][0]["end"], self.selection()["end"])
                prompt = self.prompts[-1]
                self.assertEqual(prompt.count(self.quote), 1)
                for excluded in ("PRIVATE BEFORE", "PRIVATE AFTER", "PRIVATE OTHER SCENE", "PRIVATE METADATA", "PRIVATE QUESTION", "PRIVATE ANSWER", self.store.get().wiki_pages[0].body):
                    self.assertNotIn(excluded, prompt)
        self.assertEqual(self.store.get(), original)

    def test_stale_malformed_and_wrong_scope_selections_never_call_a_model(self):
        invalid = [None, {}, {"start": True}, {"end": 10**20}, {"start": -1}, {"quote": "Invented"},
                   {"source_hash": "old"}, {"project_id": "other-project"},
                   {"scene_id": str(self.store.get().scenes[1].id)}, {"scene_id": str(self.store.get().scenes[2].id)}]
        for endpoint in ("/ai/ask", "/ai/ask/stream"):
            for changes in invalid:
                with self.subTest(endpoint=endpoint, changes=changes):
                    data = self.payload()
                    data["selected_context"] = changes if changes is None or not changes else {**data["selected_context"], **changes}
                    self.assertEqual(self.client.post(endpoint, json=data).status_code, 400)
        for mode in ([], {}, None, "other"):
            data = self.payload(); data["context_mode"] = mode
            self.assertEqual(self.client.post("/ai/ask", json=data).status_code, 400)
        self.assertEqual(self.prompts, [])

    def test_editorial_suggestions_survive_without_becoming_source_evidence_or_prose(self):
        self.quote = "A lighter is alien to history, which is paradoxical considering he sees so much more of it than anyone else."
        self.scene.text = self.quote
        original = deepcopy(self.store.get())
        question = 'I dislike "which is paradoxical considering"; can you suggest lighter wording?'
        suggestion = "A lighter is alien to history, yet he sees so much more of it than anyone else."
        answer = f"Optional suggestion: {suggestion} This keeps the contrast and removes the heavier connective."
        provider = self.app.extensions["llm_registry"].get("openai_compatible")

        def editorial_reply(endpoint, model, token, prompt):
            self.prompts.append(prompt)
            return json.dumps({"answer": answer, "evidence": evidence})

        with patch.object(provider, "complete", side_effect=editorial_reply) as complete:
            for mode in ("selection", "project"):
                for endpoint in ("/ai/ask", "/ai/ask/stream"):
                    for with_citations in (False, True):
                        with self.subTest(mode=mode, endpoint=endpoint, with_citations=with_citations):
                            evidence = [
                                {"source_type": "scene", "source_id": str(self.scene.id), "quote": self.quote},
                                {"source_type": "scene", "source_id": str(self.scene.id), "quote": suggestion},
                            ] if with_citations else []
                            data = self.payload()
                            data.update(question=question, context_mode=mode)
                            response = self.client.post(endpoint, json=data)
                            self.assertEqual(response.status_code, 200)
                            if endpoint.endswith("stream"):
                                events = [json.loads(line[6:]) for line in response.get_data(as_text=True).splitlines() if line.startswith("data: ")]
                                result = next(item["result"] for item in events if item["type"] == "result")
                            else:
                                result = response.json
                            self.assertEqual(result["answer"], answer)
                            self.assertEqual([item["quote"] for item in result["evidence"]],
                                             [self.quote] if with_citations else [])
                            prompt = self.prompts[-1]
                            self.assertIn(f"AUTHOR QUESTION:\n{question}", prompt)
                            self.assertIn(self.quote, prompt)
                            self.assertIn("Suggested wording does not need to appear in the source.", prompt)
                            self.assertIn("never your suggested wording", prompt)
                            self.assertIn("do not invent facts", prompt)
                            self.assertNotIn("Answer the author's question using only", prompt)
            self.assertEqual(complete.call_count, 8)
        self.assertEqual(self.store.get(), original)

    def test_edit_between_capture_and_request_is_rejected(self):
        data = self.payload()
        self.client.post(f"/scene/{self.scene.id}/text", data={"scene_text": "Changed. " + self.scene.text})
        response = self.client.post("/ai/ask", json=data)
        self.assertEqual(response.status_code, 400)
        self.assertIn("Select it again", response.json["error"])
        self.assertEqual(self.prompts, [])

    def test_remote_endpoint_consent_still_applies_to_selected_context(self):
        settings = self.settings.load("local-user")["llm"]
        settings.update(endpoint="https://example.test/v1", remote_consent_endpoint="")
        self.settings._save("local-user", "llm", settings)
        self.assertEqual(self.client.post("/ai/ask", json=self.payload()).status_code, 403)
        self.assertEqual(self.prompts, [])

    def test_manuscript_task_keeps_server_owned_scope_despite_selected_context(self):
        data = self.payload(); data["task_id"] = "narrative_voice"
        response = self.client.post("/ai/ask", json=data)
        self.assertEqual(response.status_code, 200)
        self.assertIn("PRIVATE BEFORE", self.prompts[-1])
        self.assertIn("PRIVATE OTHER SCENE", self.prompts[-1])
        self.assertNotIn("PRIVATE QUESTION", self.prompts[-1])

    def test_alternatives_use_exact_target_and_neighbouring_sentences_not_project_or_history(self):
        self.quote = "rather heavy"
        self.scene.text = (
            "EXCLUDED OPENING. It felt rather heavy before. 😀 It seems rather heavy today! "
            '“Dr. Mara agrees,” he said. EXCLUDED ENDING.'
        )
        original = deepcopy(self.store.get())
        data = self.payload()
        data.update(request_kind="alternatives", question="UNRELATED QUESTION")
        for endpoint in ("/ai/ask", "/ai/ask/stream"):
            with self.subTest(endpoint=endpoint):
                response = self.client.post(endpoint, json=data)
                self.assertEqual(response.status_code, 200)
                if endpoint.endswith("stream"):
                    events = [json.loads(line[6:]) for line in response.get_data(as_text=True).splitlines() if line.startswith("data: ")]
                    result = next(item["result"] for item in events if item["type"] == "result")
                    status = next(item for item in events if item["type"] == "status")
                    self.assertEqual((status["scene_count"], status["wiki_count"]), (1, 0))
                else:
                    result = response.json
                self.assertEqual(len(result["evidence"]), 1)
                self.assertEqual(result["evidence"][0]["start"], self.selection()["start"], "target evidence retains the selected repeated occurrence")
                prompt = self.prompts[-1]
                self.assertIn('It felt rather heavy before. 😀 It seems rather heavy today! “Dr. Mara agrees,” he said.', prompt)
                self.assertIn(json.dumps({name: data["selected_context"][name] for name in ("scene_id", "start", "end", "quote")}, ensure_ascii=False), prompt)
                self.assertIn("Suggest three to five alternatives", prompt)
                for excluded in ("EXCLUDED OPENING", "EXCLUDED ENDING", "PRIVATE METADATA", "PRIVATE OTHER SCENE", "PRIVATE QUESTION", "PRIVATE ANSWER", "UNRELATED QUESTION", self.store.get().wiki_pages[0].body):
                    self.assertNotIn(excluded, prompt)
        self.assertEqual(self.store.get(), original)

    def test_alternative_context_handles_boundaries_multisentence_selection_and_large_unpunctuated_text(self):
        examples = [
            ("First target. Next sentence. EXCLUDED.", "First target", "First target. Next sentence."),
            ("EXCLUDED. Previous sentence. Final target", "Final target", "Previous sentence. Final target"),
            ("EXCLUDED. Previous. One target. Second target? Following! EXCLUDED END.",
             "One target. Second target", "Previous. One target. Second target? Following!"),
            ("EXCLUDED. Previous.\n\nA target without punctuation\n\nFollowing. EXCLUDED END.",
             "A target without punctuation", "Previous.\n\nA target without punctuation\n\nFollowing."),
            ("EXCLUDED. It costs 3.14 coins.\nJ. Smith sees a target.\nAfterwards. EXCLUDED END.",
             "a target", "It costs 3.14 coins.\nJ. Smith sees a target.\nAfterwards."),
        ]
        for text, quote, expected in examples:
            with self.subTest(text=text):
                self.scene.text, self.quote = text, quote
                context, _ = prepare_alternatives(self.store.get(), str(self.scene.id), self.selection())
                start, end = context["scene_ranges"][str(self.scene.id)]
                self.assertEqual(text[start:end], expected)
        self.quote = "A target 😀"
        self.scene.text = "x" * 20000 + self.quote + "y" * 20000
        context, _ = prepare_alternatives(self.store.get(), str(self.scene.id), self.selection())
        start, end = context["scene_ranges"][str(self.scene.id)]
        self.assertEqual(end - start, 8000 + len(self.quote))
        self.assertIn(self.quote, self.scene.text[start:end])

    def test_invalid_or_unconsented_alternatives_never_call_a_provider(self):
        for endpoint in ("/ai/ask", "/ai/ask/stream"):
            for selection in (None, {}, {**self.selection(), "source_hash": "old"},
                              {**self.selection(), "project_id": "wrong"},
                              {**self.selection(), "scene_id": str(self.store.get().scenes[1].id)}):
                data = {"request_kind": "alternatives", "context_mode": "selection", "selected_context": selection}
                self.assertEqual(self.client.post(endpoint, json=data).status_code, 400)
            for kind in (None, [], {}, "other"):
                self.assertEqual(self.client.post(endpoint, json={**self.payload(), "request_kind": kind}).status_code, 400)
            self.assertEqual(self.client.post(endpoint, json={"request_kind": "alternatives"}).status_code, 400)
        self.quote = "x" * 4001
        self.scene.text = self.quote
        self.assertEqual(self.client.post("/ai/ask", json={**self.payload(), "request_kind": "alternatives"}).status_code, 400)
        self.quote, self.scene.text = "Target", "Target."
        settings = self.settings.load("local-user")["llm"]
        settings.update(endpoint="https://example.test/v1", remote_consent_endpoint="")
        self.settings._save("local-user", "llm", settings)
        self.assertEqual(self.client.post("/ai/ask", json={**self.payload(), "request_kind": "alternatives"}).status_code, 403)
        self.assertEqual(self.prompts, [])


if __name__ == "__main__":
    unittest.main()
