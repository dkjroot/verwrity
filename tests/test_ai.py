import tempfile
import unittest
import json
import hashlib
import sys
import os
import types
from unittest.mock import Mock
from base64 import b64encode
from io import BytesIO
from pathlib import Path
from unittest.mock import patch

from verwrity.ai.settings import UserAISettings
from verwrity.ai.models import KokoroModelInstaller, ModelAsset, ModelDownloadError
from verwrity.ai.llm import DEFAULT_ENDPOINTS, HTTPChatClient, LLMRegistry
from verwrity.ai.interrogation import select_context
from verwrity.ai.tts import EdgeTTSProvider, GoogleCloudTTSProvider, SynthesisOptions, TTSRegistry, _keep_kokoro_onset
from verwrity.domain.story import StoryProject
from verwrity.project.store import ProjectStore
from verwrity.web.app import create_app


class FakeProvider:
    def __init__(self, provider_id, remote=False):
        self.provider_id = provider_id
        self.display_name = provider_id
        self.is_remote = remote
        self.calls = []

    def prepare(self, settings):
        return SynthesisOptions(voice=settings["voice"], speed=settings["speed"]), {}

    def synthesize(self, text, options: SynthesisOptions, configuration):
        self.calls.append((text, options, configuration))
        return b"RIFF-audio"


class GoogleProviderTest(unittest.TestCase):
    def test_cloud_tts_uses_explicit_text_and_keeps_key_out_of_url(self):
        response = BytesIO(b'{"audioContent":"' + b64encode(b"RIFF-audio") + b'"}')
        response.__enter__ = lambda: response
        response.__exit__ = lambda *args: None
        options = SynthesisOptions(voice="en-US-Standard-C", speed=1.2, language="en-US")

        with patch("verwrity.ai.tts.urlopen", return_value=response) as mocked_urlopen:
            audio = GoogleCloudTTSProvider().synthesize(
                "Only this scene", options, {"api_key": "secret-key"}
            )

        request = mocked_urlopen.call_args.args[0]
        self.assertEqual(audio, b"RIFF-audio")
        self.assertEqual(request.full_url, "https://texttospeech.googleapis.com/v1/text:synthesize")
        self.assertEqual(request.get_header("X-goog-api-key"), "secret-key")
        self.assertIn(b"Only this scene", request.data)

    def test_keyless_edge_provider_combines_remote_audio_chunks_and_speed(self):
        call = {}

        class FakeCommunicate:
            def __init__(self, text, voice, rate):
                call.update(text=text, voice=voice, rate=rate)

            async def stream(self):
                yield {"type": "audio", "data": b"mp3-a"}
                yield {"type": "WordBoundary", "data": b"ignored"}
                yield {"type": "audio", "data": b"mp3-b"}

        with patch.dict(sys.modules, {"edge_tts": types.SimpleNamespace(Communicate=FakeCommunicate)}):
            audio = EdgeTTSProvider().synthesize(
                "Read this", SynthesisOptions(voice="en-US-AriaNeural", speed=1.2), {}
            )
        self.assertEqual(audio, b"mp3-amp3-b")
        self.assertEqual(call, {"text": "Read this", "voice": "en-US-AriaNeural", "rate": "+20%"})


class KokoroModelInstallerTest(unittest.TestCase):
    def test_downloads_and_verifies_assets_before_installing(self):
        with tempfile.TemporaryDirectory() as directory:
            contents = [b"model", b"voices"]
            assets = tuple(
                ModelAsset(f"asset-{index}.bin", len(data), hashlib.sha256(data).hexdigest(), f"https://example.test/{index}")
                for index, data in enumerate(contents)
            )
            installer = KokoroModelInstaller(directory, assets)
            with patch("verwrity.ai.models.urlopen", side_effect=[BytesIO(data) for data in contents]) as mocked:
                installed = installer.install()
            self.assertEqual(mocked.call_count, 2)
            self.assertEqual([Path(installed[asset.filename]).read_bytes() for asset in assets], contents)
            self.assertTrue(installer.ready())

    def test_rejects_bad_hash_and_removes_partial_download(self):
        with tempfile.TemporaryDirectory() as directory:
            asset = ModelAsset("asset.bin", 5, "0" * 64, "https://example.test/asset")
            installer = KokoroModelInstaller(directory, (asset,))
            with patch("verwrity.ai.models.urlopen", return_value=BytesIO(b"wrong")):
                with self.assertRaisesRegex(ModelDownloadError, "SHA-256"):
                    installer.install()
            self.assertFalse((Path(directory) / asset.filename).exists())
            self.assertEqual(list(Path(directory).iterdir()), [])


class KokoroAudioOnsetTest(unittest.TestCase):
    def test_retains_a_preroll_before_kokoro_trim_boundary(self):
        samples = list(range(10_000))
        retained = _keep_kokoro_onset(
            samples,
            1_000,
            lambda audio: (audio[1_500:9_000], (1_500, 9_000)),
        )
        self.assertEqual(retained[0], 1_250)
        self.assertEqual(retained[-1], 9_079)

    def test_local_provider_disables_aggressive_default_trim(self):
        calls = {}
        captured_audio = {}

        class FakeKokoro:
            def __init__(self, model_path, voices_path):
                pass

            def create(self, text, **options):
                calls.update(options)
                return list(range(10_000)), 1_000

        kokoro_module = types.ModuleType("kokoro_onnx")
        kokoro_module.__path__ = []
        kokoro_module.Kokoro = FakeKokoro
        trim_module = types.ModuleType("kokoro_onnx.trim")
        trim_module.trim = lambda audio: (audio[1_500:9_000], (1_500, 9_000))
        soundfile_module = types.ModuleType("soundfile")

        def write(output, samples, sample_rate, format):
            captured_audio.update(samples=samples, sample_rate=sample_rate, format=format)
            output.write(b"RIFF-audio")

        soundfile_module.write = write
        with tempfile.TemporaryDirectory() as directory:
            model_path = Path(directory, "model.onnx")
            voices_path = Path(directory, "voices.bin")
            model_path.touch()
            voices_path.touch()
            with patch.dict(sys.modules, {
                "kokoro_onnx": kokoro_module,
                "kokoro_onnx.trim": trim_module,
                "soundfile": soundfile_module,
            }):
                from verwrity.ai.tts import KokoroLocalProvider

                audio = KokoroLocalProvider().synthesize(
                    "First word stays", SynthesisOptions(voice="af_sarah"), {
                        "model_path": str(model_path), "voices_path": str(voices_path), "device": "cpu",
                    },
                )
        self.assertEqual(audio, b"RIFF-audio")
        self.assertFalse(calls["trim"], "Kokoro's default trimming can crop a quiet first phoneme")
        self.assertEqual(captured_audio["samples"][0], 1_250)
        self.assertEqual(captured_audio["sample_rate"], 1_000)


class AIModelsTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.project = StoryProject.demo()
        self.app = create_app(ProjectStore(self.project))
        self.app.config["PROJECT_LIBRARY"].root = Path(self.directory.name)
        self.app.config["PROJECT_DRAFT_ROOT"] = Path(self.directory.name)
        self.app.extensions["ai_settings"] = UserAISettings(Path(self.directory.name))
        self.client = self.app.test_client()
        self.client.get("/")
        self.store = next(iter(self.app.config["PROJECT_STORES"].values()))
        self.scene = self.store.get().scenes[0]

    def test_llm_settings_are_private_and_preserve_tts_settings(self):
        settings = self.app.extensions["ai_settings"]
        registry = self.app.extensions["llm_registry"]
        with self.assertRaisesRegex(ValueError, "Acknowledge"):
            settings.update_llm("local-user", {
                "standard": "openai_compatible", "endpoint": "https://api.example.test/v1",
                "model": "remote-model", "token": "top-secret",
            }, registry)
        configured = settings.update_llm("local-user", {
            "standard": "openai_compatible", "endpoint": "https://api.example.test/v1",
            "model": "remote-model", "token": "top-secret", "remote_consent": True,
        }, registry)
        self.assertTrue(configured["token_configured"])
        self.assertEqual(configured["token"], "")
        stored = settings.load("local-user")
        self.assertEqual(stored["llm"]["token"], "top-secret")
        self.assertEqual(stored["tts"]["provider"], "kokoro_local")
        if os.name != "nt":  # Windows stat mode does not report ACL permissions.
            self.assertEqual(Path(self.directory.name, "local-user", "ai_models.json").stat().st_mode & 0o777, 0o600)
        local = settings.update_llm("local-user", {
            "standard": "openai_compatible", "endpoint": "http://127.0.0.1:8080/v1", "model": "local-model",
        }, registry)
        self.assertFalse(local["token_configured"], "a remote token is not forwarded to a newly selected endpoint")

    def test_local_llama_cpp_style_endpoint_needs_no_token_or_remote_consent(self):
        settings = self.app.extensions["ai_settings"]
        result = settings.update_llm("local-user", {
            "standard": "openai_compatible", "endpoint": "http://127.0.0.1:8080/v1", "model": "llama-local",
        }, self.app.extensions["llm_registry"])
        self.assertFalse(result["token_configured"])
        self.assertFalse(result["remote_consent"])

    def test_local_openai_root_is_normalized_to_plain_http_and_v1(self):
        result = self.app.extensions["ai_settings"].update_llm("local-user", {
            "standard": "openai_compatible", "endpoint": "https://localhost:8081", "model": "local-model",
        }, self.app.extensions["llm_registry"])
        self.assertEqual(result["endpoint"], "http://localhost:8081/v1")
        self.assertFalse(result["remote_consent"])

    def test_nonlocal_http_model_endpoint_cannot_be_saved(self):
        with self.assertRaisesRegex(ValueError, "HTTPS"):
            self.app.extensions["ai_settings"].update_llm("local-user", {
                "endpoint": "http://model.example.test/v1", "model": "model", "remote_consent": True,
            }, self.app.extensions["llm_registry"])

    def test_project_question_uses_context_evidence_and_does_not_mutate_source(self):
        class FakeLLM:
            standard_id = "openai_compatible"
            display_name = "fake"
            default_endpoint = "http://127.0.0.1:8080/v1"

            def __init__(self, project):
                self.project = project
                self.prompts = []

            def complete(self, endpoint, model, token, prompt):
                self.prompts.append((endpoint, model, token, prompt))
                scene = self.project.current_scenes()[0]
                return __import__("json").dumps({"answer": "The passage says this.", "evidence": [
                    {"source_type": "scene", "source_id": str(scene.id), "quote": scene.text[:20]},
                    {"source_type": "scene", "source_id": str(scene.id), "quote": "Invented passage"},
                ]})

        project = self.store.get()
        original_text = [scene.text for scene in project.current_scenes()]
        original_wiki = [(page.title, page.body) for page in project.wiki_pages]
        fake = FakeLLM(project)
        self.app.extensions["llm_registry"] = LLMRegistry([fake])
        self.app.extensions["ai_settings"].update_llm("local-user", {
            "standard": "openai_compatible", "endpoint": "https://localhost:8081", "model": "test-model",
        }, self.app.extensions["llm_registry"])

        response = self.client.post("/ai/ask", json={
            "question": "Ask any project question", "before_percent": 100, "after_percent": 100,
            "include_wiki": True, "history": [{"question": "Earlier question", "answer": "Earlier answer"}],
        })

        self.assertEqual(response.status_code, 200)
        result = response.get_json()
        self.assertEqual(result["answer"], "The passage says this.")
        self.assertEqual(len(result["evidence"]), 1)
        self.assertEqual(result["evidence"][0]["start"], 0)
        self.assertEqual(fake.prompts[0][0], "http://localhost:8081/v1")
        prompt = fake.prompts[0][3]
        self.assertIn("Earlier question", prompt)
        self.assertIn(project.wiki_pages[0].body, prompt)
        self.assertEqual([scene.text for scene in project.current_scenes()], original_text)
        self.assertEqual([(page.title, page.body) for page in project.wiki_pages], original_wiki)

    def test_remote_question_requires_saved_consent_for_exact_endpoint(self):
        class FakeLLM:
            standard_id = "openai_compatible"
            display_name = "fake"
            default_endpoint = "https://example.test/v1"

            def __init__(self): self.calls = 0
            def complete(self, *args): self.calls += 1; return '{"answer":"x","evidence":[]}'

        fake = FakeLLM()
        self.app.extensions["llm_registry"] = LLMRegistry([fake])
        settings = self.app.extensions["ai_settings"]
        configured = settings.load("local-user")["llm"]
        configured.update(endpoint="https://example.test/v1", model="test-model", remote_consent_endpoint="")
        settings._save("local-user", "llm", configured)
        response = self.client.post("/ai/ask", json={"question": "A question"})
        self.assertEqual(response.status_code, 403)
        self.assertEqual(fake.calls, 0)

    def test_streamed_question_delivers_answer_and_verified_evidence(self):
        class FakeLLM:
            standard_id = "openai_compatible"
            display_name = "fake"
            default_endpoint = "http://localhost:8081/v1"
            def stream(self, *args):
                yield '{"answer":"A streamed answer\\n'
                yield 'continues.","evidence":[]}'

        self.app.extensions["llm_registry"] = LLMRegistry([FakeLLM()])
        self.app.extensions["ai_settings"].update_llm("local-user", {
            "standard": "openai_compatible", "endpoint": "http://localhost:8081", "model": "test-model",
        }, self.app.extensions["llm_registry"])
        response = self.client.post("/ai/ask/stream", json={"question": "Ask anything"})
        self.assertEqual(response.status_code, 200)
        output = response.get_data(as_text=True)
        self.assertIn('"type": "status"', output)
        self.assertIn('"estimated_context_tokens"', output)
        self.assertIn('"type": "delta", "text": "A streamed answer\\n"', output)
        self.assertIn('"type": "result"', output)
        self.assertIn('"answer": "A streamed answer\\ncontinues."', output)

    def test_context_percentage_range_excludes_historical_scenes(self):
        project = self.store.get()
        project.scenes[0].text = "first"
        project.scenes[1].text = "second"
        project.scenes[2].text = "third"
        selected = select_context(project, str(project.scenes[1].id), 0, 0, False)
        self.assertIn("second", selected["text"])
        self.assertNotIn("first", selected["text"])
        self.assertNotIn("third", selected["text"])
        self.assertNotIn("HUMAN-AUTHORED WIKI PAGES", selected["text"])


    def tearDown(self):
        self.directory.cleanup()

    def test_model_settings_are_user_scoped_and_hide_api_key(self):
        registry = TTSRegistry()
        settings = UserAISettings(Path(self.directory.name))
        with self.assertRaisesRegex(ValueError, "remote provider receives manuscript"):
            settings.update_tts("local-user", {"provider": "google_cloud_tts", "google_api_key": "secret"}, registry)
        saved = settings.update_tts("local-user", {
            "provider": "google_cloud_tts", "google_api_key": "secret", "remote_consent": True,
        }, registry)
        self.assertTrue(saved["google_api_key_configured"])
        self.assertEqual(saved["google_api_key"], "")
        self.assertEqual(settings.load("local-user")["tts"]["google_api_key"], "secret")
        if os.name != "nt":  # Keep the exact Unix permission assertion on Unix.
            self.assertEqual(Path(self.directory.name, "local-user", "ai_models.json").stat().st_mode & 0o777, 0o600)

    def test_remote_consent_is_saved_for_the_specific_provider(self):
        settings = UserAISettings(Path(self.directory.name))
        registry = TTSRegistry()
        settings.update_tts("local-user", {"provider": "edge_tts", "remote_consent": True}, registry)
        self.assertTrue(settings.public("local-user")["tts"]["remote_consent"])
        with self.assertRaisesRegex(ValueError, "selected remote provider"):
            settings.update_tts("local-user", {"provider": "google_cloud_tts", "google_api_key": "secret"}, registry)

    def test_local_read_aloud_uses_active_scene_and_leaves_manuscript_unchanged(self):
        provider = FakeProvider("fake_local")
        self.app.extensions["tts_registry"] = TTSRegistry([provider])
        settings = self.app.extensions["ai_settings"]
        settings.update_tts("local-user", {"provider": "fake_local"}, self.app.extensions["tts_registry"])
        original_text = self.scene.text

        response = self.client.post(f"/scene/{self.scene.id}/read-aloud", json={})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.mimetype, "audio/wav")
        self.assertEqual(response.data, b"RIFF-audio")
        self.assertEqual(provider.calls[0][0], original_text)
        self.assertEqual(provider.calls[0][1].voice, "af_sarah")
        self.assertEqual(self.scene.text, original_text)

    def test_remote_provider_uses_saved_consent_without_reprompting(self):
        provider = FakeProvider("fake_remote", remote=True)
        self.app.extensions["tts_registry"] = TTSRegistry([provider])
        settings = self.app.extensions["ai_settings"]
        settings.update_tts("local-user", {"provider": "fake_remote", "remote_consent": True}, self.app.extensions["tts_registry"])

        response = self.client.post(f"/scene/{self.scene.id}/read-aloud", json={})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(provider.calls), 1)
        self.assertEqual(provider.calls[0][0], self.scene.text)

    def test_read_completed_answer_uses_configured_tts_and_preserves_manuscript(self):
        provider = FakeProvider("fake_local")
        self.app.extensions["tts_registry"] = TTSRegistry([provider])
        settings = self.app.extensions["ai_settings"]
        settings.update_tts("local-user", {"provider": "fake_local"}, self.app.extensions["tts_registry"])
        original_text = self.scene.text

        response = self.client.post("/ai/read-answer", json={"text": "A completed model response."})

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.mimetype, "audio/wav")
        self.assertEqual(response.data, b"RIFF-audio")
        self.assertEqual(provider.calls[0][0], "A completed model response.")
        self.assertEqual(self.scene.text, original_text)

    def test_read_completed_answer_requires_saved_consent_for_remote_tts(self):
        provider = FakeProvider("fake_remote", remote=True)
        self.app.extensions["tts_registry"] = TTSRegistry([provider])
        settings = self.app.extensions["ai_settings"]
        configured = settings.load("local-user")["tts"]
        configured.update(provider="fake_remote", remote_consent_provider="")
        settings._save("local-user", "tts", configured)

        response = self.client.post("/ai/read-answer", json={"text": "Answer text"})

        self.assertEqual(response.status_code, 403)
        self.assertEqual(provider.calls, [])

    def test_kokoro_download_is_an_explicit_action_and_saves_installed_paths(self):
        settings = self.app.extensions["ai_settings"]
        registry = self.app.extensions["tts_registry"]
        settings.update_tts("local-user", {"provider": "kokoro_local"}, registry)
        with patch("verwrity.web.routes.ai.KokoroModelInstaller") as installer_class:
            installer_class.return_value.install.return_value = {
                "kokoro-v1.0.onnx": "/models/kokoro-v1.0.onnx",
                "voices-v1.0.bin": "/models/voices-v1.0.bin",
            }
            installer_class.return_value.ready.return_value = False
            response = self.client.post("/ai/models/tts/kokoro-download")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(installer_class.call_count, 1)
        configured = settings.load("local-user")["tts"]
        self.assertEqual(configured["model_path"], "/models/kokoro-v1.0.onnx")
        self.assertEqual(configured["voices_path"], "/models/voices-v1.0.bin")

    def test_cannot_read_a_non_active_scene(self):
        provider = FakeProvider("fake_local")
        self.app.extensions["tts_registry"] = TTSRegistry([provider])
        self.app.extensions["ai_settings"].update_tts("local-user", {"provider": "fake_local"}, self.app.extensions["tts_registry"])
        other_scene = self.store.get().scenes[1]

        response = self.client.post(f"/scene/{other_scene.id}/read-aloud", json={})

        self.assertEqual(response.status_code, 404)
        self.assertEqual(provider.calls, [])


class LLMHTTPClientTest(unittest.TestCase):
    def test_known_api_defaults_and_registry(self):
        choices = {item["id"]: item for item in LLMRegistry().choices()}
        self.assertEqual(choices["openai_compatible"]["default_endpoint"], "https://api.openai.com/v1")
        self.assertEqual(choices["anthropic"]["default_endpoint"], "https://api.anthropic.com")
        self.assertEqual(choices["google"]["default_endpoint"], "https://generativelanguage.googleapis.com/v1beta")

    def test_provider_standards_build_expected_authenticated_requests(self):
        cases = [
            ("openai_compatible", "https://api.example.test/v1", "/chat/completions", "Authorization", "Bearer secret", b'{"choices":[{"message":{"content":"reply"}}]}'),
            ("anthropic", "https://api.example.test", "/v1/messages", "X-api-key", "secret", b'{"content":[{"type":"text","text":"reply"}]}'),
            ("google", "https://api.example.test/v1beta", "/models/test-model:generateContent", "X-goog-api-key", "secret", b'{"candidates":[{"content":{"parts":[{"text":"reply"}]}}]}'),
        ]
        for standard, base, path, header, value, payload in cases:
            with self.subTest(standard=standard):
                response = BytesIO(payload)
                response.__enter__ = lambda: response
                response.__exit__ = lambda *args: None
                client = LLMRegistry().get(standard)
                opener = Mock()
                opener.open.return_value = response
                with patch("verwrity.ai.llm.build_opener", return_value=opener):
                    answer = client.complete(base, "test-model", "secret", "Only selected project data")
                request = opener.open.call_args.args[0]
                self.assertEqual(answer, "reply")
                self.assertIn(path, request.full_url)
                self.assertEqual(request.get_header(header), value)

    def test_nonlocal_http_is_rejected(self):
        client = HTTPChatClient("openai_compatible", "test", DEFAULT_ENDPOINTS["openai_compatible"])
        with self.assertRaisesRegex(ValueError, "HTTPS"):
            client.complete("http://example.test/v1", "model", "", "question")

    def test_loopback_root_builds_local_http_v1_chat_completions_url(self):
        response = BytesIO(b'{"choices":[{"message":{"content":"reply"}}]}')
        response.__enter__ = lambda: response
        response.__exit__ = lambda *args: None
        opener = Mock()
        opener.open.return_value = response
        client = LLMRegistry().get("openai_compatible")
        with patch("verwrity.ai.llm.build_opener", return_value=opener):
            self.assertEqual(client.complete("https://localhost:8081", "model", "", "question"), "reply")
        request = opener.open.call_args.args[0]
        self.assertEqual(request.full_url, "http://localhost:8081/v1/chat/completions")
        self.assertIsNone(request.get_header("Authorization"))

    def test_openai_compatible_stream_yields_sse_content_deltas(self):
        response = BytesIO(b'data: {"choices":[{"delta":{"content":"first "}}]}\n\ndata: {"choices":[{"delta":{"content":"second"}}]}\n\ndata: [DONE]\n\n')
        response.__enter__ = lambda: response
        response.__exit__ = lambda *args: None
        opener = Mock()
        opener.open.return_value = response
        client = LLMRegistry().get("openai_compatible")
        with patch("verwrity.ai.llm.build_opener", return_value=opener):
            self.assertEqual(list(client.stream("http://localhost:8081", "model", "", "question")), ["first ", "second"])
        request = opener.open.call_args.args[0]
        self.assertEqual(request.full_url, "http://localhost:8081/v1/chat/completions")
        self.assertTrue(json.loads(request.data)["stream"])
