import json
import tempfile
import types
import unittest
from copy import deepcopy
from io import BytesIO
from pathlib import Path
from unittest.mock import Mock, patch
from urllib.error import HTTPError

from verwrity.ai.settings import DEFAULT_AI_SETTINGS, UserAISettings
from verwrity.ai.stt import AudioInput, FasterWhisperProvider, OpenAITranscriptionProvider, STTConfigurationError, STTRegistry, STTRequestError, checked_endpoint
from verwrity.domain.story import StoryProject
from verwrity.project.store import ProjectStore
from verwrity.web.app import create_app


class STTTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.settings = UserAISettings(self.directory.name)
        self.app = create_app(ProjectStore(StoryProject.demo()))
        self.app.config["PROJECT_DRAFT_ROOT"] = Path(self.directory.name) / "drafts"
        self.app.extensions["ai_settings"] = self.settings
        self.client = self.app.test_client()
        self.registry = self.app.extensions["stt_registry"]

    def test_settings_roundtrip_keeps_other_capabilities_private(self):
        result = self.settings.update_stt("local-user", {"provider": "openai_compatible", "endpoint": "https://voice.example/v1", "model": "whisper", "token": "secret", "remote_consent": True, "shortcut": "F8"}, self.registry)
        self.assertEqual(result["token"], "")
        self.assertTrue(result["token_configured"])
        self.assertTrue(result["remote_consent"])
        self.assertNotIn("secret", json.dumps(self.client.get("/ai/models").json))
        saved = self.settings.load("local-user")
        self.assertEqual(saved["stt"]["shortcut"], "F8")
        self.assertEqual(saved["stt"]["token"], "secret")
        self.assertEqual(saved["tts"]["provider"], "kokoro_local")
        self.assertEqual(saved["llm"], DEFAULT_AI_SETTINGS["llm"])

    def test_remote_consent_is_explicit_endpoint_specific_and_rechecked(self):
        values = {"provider": "openai_compatible", "endpoint": "https://voice.example/v1", "model": "whisper"}
        with self.assertRaisesRegex(ValueError, "Acknowledge"):
            self.settings.update_stt("local-user", values, self.registry)
        with self.assertRaisesRegex(ValueError, "explicitly"):
            self.settings.update_stt("local-user", {**values, "remote_consent": "true"}, self.registry)
        self.settings.update_stt("local-user", {**values, "token": "secret", "remote_consent": True}, self.registry)
        with self.assertRaisesRegex(ValueError, "Acknowledge"):
            self.settings.update_stt("local-user", {"endpoint": "https://other.example/v1"}, self.registry)
        value = self.settings.update_stt("local-user", {"endpoint": "https://other.example/v1", "remote_consent": True}, self.registry)
        self.assertFalse(value["token_configured"])
        configured = self.settings.load("local-user")["stt"]
        configured["remote_consent_endpoint"] = "https://voice.example/v1"
        self.settings._save("local-user", "stt", configured)
        with patch.object(self.registry.get("openai_compatible"), "transcribe") as transcribe:
            response = self.client.post("/ai/transcribe", data=b"audio", content_type="audio/webm")
        self.assertEqual(response.status_code, 403)
        transcribe.assert_not_called()

    def test_known_hosted_services_require_keys_but_custom_servers_can_be_keyless(self):
        for endpoint in ("https://api.groq.com/openai/v1", "https://api.openai.com/v1"):
            values = {"provider": "openai_compatible", "endpoint": endpoint, "model": "whisper", "remote_consent": True}
            with self.assertRaisesRegex(STTConfigurationError, "requires an API key"):
                self.settings.update_stt("local-user", values, self.registry)
            value = self.settings.update_stt("local-user", {**values, "token": "private-key"}, self.registry)
            self.assertTrue(value["token_required"])
            self.assertTrue(value["token_configured"])
            self.assertEqual(value["token"], "")
            value = self.settings.update_stt("local-user", {}, self.registry)
            self.assertTrue(value["token_configured"], "A saved key need not be re-entered")
            value = self.settings.update_stt("local-user", {"forget_token": True}, self.registry)
            self.assertFalse(value["token_configured"], "Removing a secret must remain possible")
            with patch("verwrity.ai.stt.build_opener") as opener:
                response = self.client.post("/ai/transcribe", data=b"audio", content_type="audio/webm")
            self.assertEqual(response.status_code, 400)
            self.assertIn("requires an API key", response.json["error"])
            opener.assert_not_called()
        for endpoint in ("localhost:8080", "https://keyless.example/v1"):
            value = self.settings.update_stt("local-user", {"endpoint": endpoint, "remote_consent": True}, self.registry)
            self.assertFalse(value["token_required"])
            self.assertFalse(value["token_configured"])

    def test_transcription_returns_only_text_without_mutating_project(self):
        self.client.get("/")
        store = next(iter(self.app.config["PROJECT_STORES"].values()))
        before = deepcopy(store.get())
        provider = self.registry.get("faster_whisper")
        with patch.object(provider, "transcribe", return_value="Dictated words.") as transcribe:
            response = self.client.post("/ai/transcribe", data=b"audio", content_type="audio/webm")
        self.assertEqual(response.json, {"text": "Dictated words."})
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        self.assertEqual(store.get(), before)
        self.assertEqual(transcribe.call_args.args[0], AudioInput(b"audio", "audio/webm"))

    def test_empty_unsupported_oversized_audio_and_private_errors(self):
        for data, media_type in ((b"", "audio/webm"), (b"hello", "text/plain")):
            self.assertEqual(self.client.post("/ai/transcribe", data=data, content_type=media_type).status_code, 400)
        with patch("verwrity.web.routes.ai.MAX_AUDIO_BYTES", 3):
            self.assertEqual(self.client.post("/ai/transcribe", data=b"1234", content_type="audio/webm").status_code, 400)
        with patch.object(self.registry.get("faster_whisper"), "transcribe", side_effect=RuntimeError("private credential")):
            response = self.client.post("/ai/transcribe", data=b"audio", content_type="audio/webm")
        self.assertEqual(response.status_code, 502)
        self.assertNotIn("private", response.get_data(as_text=True))

    def test_loopback_normalization_and_validation(self):
        saved = self.settings.update_stt("local-user", {"provider": "openai_compatible", "endpoint": "localhost:8080", "model": "whisper"}, self.registry)
        self.assertEqual(saved["endpoint"], "http://localhost:8080/v1")
        self.assertFalse(saved["remote_consent"])
        for endpoint in ("http://remote.example", "https://secret@remote.example", "https://remote.example?token=secret", "https://remote.example:bad", "file:///x"):
            with self.assertRaises(ValueError):
                checked_endpoint(endpoint)
        for values in ({"shortcut": "KeyA"}, {"language": "English"}, {"provider": "unknown"}, {"token": "secret\nheader"}, {"device": "bad"}):
            with self.assertRaises(ValueError):
                self.settings.update_stt("local-user", values, self.registry)

    def test_local_requires_tokenizer_and_never_downloads_during_inference(self):
        provider = FasterWhisperProvider()
        folder = Path(self.directory.name) / "model"
        folder.mkdir()
        values = {**DEFAULT_AI_SETTINGS["stt"], "model_path": str(folder)}
        constructor = Mock()
        module = types.SimpleNamespace(WhisperModel=constructor)
        with patch.dict("sys.modules", {"faster_whisper": module}), patch("verwrity.ai.stt._decode_audio", return_value=types.SimpleNamespace(size=1)):
            with self.assertRaisesRegex(STTConfigurationError, "complete"):
                provider.transcribe(AudioInput(b"audio", "audio/webm"), values)
            constructor.assert_not_called()
            for name in ("model.bin", "config.json", "tokenizer.json"):
                (folder / name).write_text("test")
            constructor.return_value.transcribe.return_value = ([types.SimpleNamespace(text=" Hello."), types.SimpleNamespace(text=" World.")], None)
            self.assertEqual(provider.transcribe(AudioInput(b"audio", "audio/webm"), values), "Hello. World.")
            provider.transcribe(AudioInput(b"audio", "audio/webm"), values)
            constructor.assert_called_once()
            self.assertIs(constructor.call_args.kwargs["local_files_only"], True)
            self.assertEqual(constructor.return_value.transcribe.call_args.kwargs["task"], "transcribe")

    def test_download_is_explicit_and_saved_only_after_success(self):
        default = str((Path(self.directory.name) / "local-user" / "ai_models" / "whisper").resolve())
        public = self.client.get("/ai/models").json["settings"]["stt"]
        self.assertEqual(public["download_directory"], default)
        self.assertEqual(public["model_path"], "")
        with patch("verwrity.web.routes.ai.download_whisper_model", return_value="local-model") as download:
            self.assertEqual(self.client.post("/ai/models/stt/download", json={"model": "base.en"}).status_code, 400)
            download.assert_not_called()
            response = self.client.post("/ai/models/stt/download", json={"model": "base.en", "accept_download": True})
            self.assertEqual(download.call_args.args[1], Path(default))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.settings.load("local-user")["stt"]["model_path"], "local-model")

    def test_http_multipart_has_only_audio_options_and_auth_in_header(self):
        provider = OpenAITranscriptionProvider()
        settings = {**DEFAULT_AI_SETTINGS["stt"], "endpoint": "https://voice.example/v1", "model": "whisper", "token": "secret", "remote_consent_endpoint": "https://voice.example/v1"}
        opener = Mock()
        opener.open.return_value.__enter__ = Mock(return_value=BytesIO(b'{"text":"spoken words"}'))
        opener.open.return_value.__exit__ = Mock(return_value=False)
        with patch("verwrity.ai.stt.build_opener", return_value=opener) as build:
            text = provider.transcribe(AudioInput(b"recording-bytes", "audio/webm"), settings)
        self.assertEqual(text, "spoken words")
        request = opener.open.call_args.args[0]
        self.assertEqual(request.full_url, "https://voice.example/v1/audio/transcriptions")
        self.assertEqual(request.get_header("Authorization"), "Bearer secret")
        self.assertNotIn(b"secret", request.data)
        self.assertIn(b"recording-bytes", request.data)
        self.assertEqual(build.call_args.args[0].__name__, "_NoRedirect")
        opener.open.side_effect = HTTPError(request.full_url, 302, "private", {}, None)
        with patch("verwrity.ai.stt.build_opener", return_value=opener), self.assertRaisesRegex(STTConfigurationError, "refused to forward"):
            provider.transcribe(AudioInput(b"recording-bytes", "audio/webm"), settings)

    def test_authentication_and_quota_errors_are_actionable_and_logs_are_private(self):
        provider = OpenAITranscriptionProvider()
        settings = {**DEFAULT_AI_SETTINGS["stt"], "endpoint": "https://voice.example/v1", "model": "whisper", "token": "private-token", "remote_consent_endpoint": "https://voice.example/v1"}
        for code, error_type, message in ((401, STTConfigurationError, "valid API"), (403, STTConfigurationError, "authentication"), (429, STTRequestError, "quota"), (400, STTRequestError, "HTTP 400")):
            with self.subTest(code=code):
                opener = Mock()
                opener.open.side_effect = HTTPError("https://private-host.invalid", code, "private-service-response", {}, None)
                with patch("verwrity.ai.stt.build_opener", return_value=opener), self.assertLogs("verwrity.ai.stt", level="INFO") as logs:
                    with self.assertRaisesRegex(error_type, message):
                        provider.transcribe(AudioInput(b"private-recording", "audio/webm"), settings)
                output = "\n".join(logs.output)
                self.assertIn(f"HTTP {code}", output)
                for private in ("private-token", "private-recording", "private-host", "private-service-response"):
                    self.assertNotIn(private, output)

    def test_missing_cuda_runtime_has_safe_actionable_error(self):
        folder = Path(self.directory.name) / "model"
        folder.mkdir()
        for name in ("model.bin", "config.json", "tokenizer.json"):
            (folder / name).write_text("test")
        settings = {**DEFAULT_AI_SETTINGS["stt"], "model_path": str(folder), "device": "cuda", "compute_type": "float16"}
        constructor = Mock(side_effect=RuntimeError("Library cublas64_12.dll cannot be loaded from private-directory"))
        with patch.dict("sys.modules", {"faster_whisper": types.SimpleNamespace(WhisperModel=constructor)}), self.assertLogs("verwrity.ai.stt", level="INFO") as logs:
            with self.assertRaisesRegex(STTConfigurationError, "Choose CPU with int8") as error:
                FasterWhisperProvider().transcribe(AudioInput(b"private-recording", "audio/webm"), settings)
        self.assertNotIn("private-directory", str(error.exception))
        self.assertNotIn("private-directory", "\n".join(logs.output))
        self.assertIn("runtime libraries unavailable", "\n".join(logs.output))

    def test_route_logs_stages_and_timing_without_transcript_or_audio(self):
        with patch.object(self.registry.get("faster_whisper"), "transcribe", return_value="private-transcript"), self.assertLogs("verwrity", level="INFO") as logs:
            response = self.client.post("/ai/transcribe", data=b"private-audio", content_type="audio/webm")
        self.assertEqual(response.status_code, 200)
        output = "\n".join(logs.output)
        for stage in ("started", "receiving recorded audio", "transcribing audio", "returning transcript", "completed in"):
            self.assertIn(stage, output)
        for private in ("private-audio", "private-transcript"):
            self.assertNotIn(private, output)


if __name__ == "__main__":
    unittest.main()
