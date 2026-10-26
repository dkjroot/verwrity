"""Atomic, user-scoped AI provider choices and configuration."""

from __future__ import annotations

import json
import re
from pathlib import Path
from tempfile import NamedTemporaryFile
from urllib.parse import urlparse

from verwrity.ai.llm import DEFAULT_ENDPOINTS, LLMRegistry, _is_loopback, normalize_endpoint
from verwrity.ai.models import KokoroModelInstaller
from verwrity.ai.tts import TTSRegistry
from verwrity.ai.stt import STTRegistry, SHORTCUTS, checked_endpoint, api_key_service, require_api_key
from verwrity.ai.ocr import OCR_DEFAULTS, REMOTE_OCR, checked_settings
from verwrity.ai.ocr_models import discovered_directory, managed_directory, readiness


DEFAULT_AI_SETTINGS: dict[str, object] = {
    "ocr_test": {},
    "ocr": OCR_DEFAULTS,
    "stt": {
        "provider": "faster_whisper", "model_path": "", "device": "cpu",
        "compute_type": "int8", "language": "en", "shortcut": "ControlRight",
        "endpoint": "http://localhost:8080/v1", "model": "whisper-1",
        "token": "", "token_endpoint": "", "remote_consent_endpoint": "",
    },
    "tts": {
        "provider": "kokoro_local",
        "voice": "af_sarah",
        "speed": 1.0,
        "device": "cpu",
        "model_path": "",
        "voices_path": "",
        "google_api_key": "",
        "google_voice": "en-US-Standard-C",
        "edge_voice": "en-US-AriaNeural",
        "remote_consent_provider": "",
    },
    "llm": {
        "standard": "openai_compatible",
        "endpoint": DEFAULT_ENDPOINTS["openai_compatible"],
        "model": "",
        "token": "",
        "token_endpoint": DEFAULT_ENDPOINTS["openai_compatible"],
        "token_standard": "openai_compatible",
        "remote_consent_endpoint": "",
    },
}


class UserAISettings:
    """Store AI preferences under user_files, outside portable story archives."""

    def __init__(self, root: Path | str = "user_files") -> None:
        self.root = Path(root)

    def _path(self, user_id: str) -> Path:
        if not user_id or Path(user_id).name != user_id or user_id in {".", ".."}:
            raise ValueError("Invalid user identifier")
        return self.root / user_id / "ai_models.json"

    def load(self, user_id: str) -> dict[str, object]:
        result = json.loads(json.dumps(DEFAULT_AI_SETTINGS))
        try:
            saved = json.loads(self._path(user_id).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            saved = {}
        saved_tts = saved.get("tts") if isinstance(saved, dict) else None
        if isinstance(saved_tts, dict):
            values = result["tts"]
            for key in ("provider", "voice", "device", "model_path", "voices_path", "google_api_key", "google_voice", "edge_voice"):
                if isinstance(saved_tts.get(key), str):
                    values[key] = saved_tts[key]
            if isinstance(saved_tts.get("speed"), (int, float)) and not isinstance(saved_tts["speed"], bool) and 0.5 <= saved_tts["speed"] <= 2.0:
                values["speed"] = float(saved_tts["speed"])
            if isinstance(saved_tts.get("remote_consent_provider"), str):
                values["remote_consent_provider"] = saved_tts["remote_consent_provider"]
            elif saved_tts.get("remote_consent") is True:
                # Migrate earlier prototype settings that stored one global consent.
                values["remote_consent_provider"] = str(values["provider"])
            values["remote_consent"] = values["remote_consent_provider"] == values["provider"]
        saved_llm = saved.get("llm") if isinstance(saved, dict) else None
        if isinstance(saved_llm, dict):
            llm = result["llm"]
            for key in ("standard", "endpoint", "model", "token", "token_endpoint", "token_standard", "remote_consent_endpoint"):
                if isinstance(saved_llm.get(key), str):
                    llm[key] = saved_llm[key]
            if saved_llm.get("token") and "token_endpoint" not in saved_llm:
                llm["token_endpoint"] = llm["endpoint"]
                llm["token_standard"] = llm["standard"]
            llm["endpoint"] = normalize_endpoint(str(llm["endpoint"]), str(llm["standard"]))
        saved_stt = saved.get("stt") if isinstance(saved, dict) else None
        if isinstance(saved_stt, dict):
            for key in result["stt"]:
                if isinstance(saved_stt.get(key), str):
                    result["stt"][key] = saved_stt[key]
        saved_ocr = saved.get("ocr") if isinstance(saved, dict) else None
        if isinstance(saved_ocr, dict):
            try:
                result["ocr"] = checked_settings(saved_ocr)
            except ValueError:
                pass
        if result["ocr"]["provider"] not in REMOTE_OCR and not result["ocr"]["model_path"]:
            result["ocr"]["model_path"] = discovered_directory(self.root, user_id, result["ocr"]["provider"])
        if isinstance(saved, dict) and isinstance(saved.get("ocr_test"), dict):
            result["ocr_test"] = saved["ocr_test"]
        return result

    def public(self, user_id: str) -> dict[str, object]:
        value = self.load(user_id)
        tts = value["tts"]
        installer = KokoroModelInstaller(self.model_root(user_id))
        ready = installer.ready()
        llm = value["llm"]
        stt = value["stt"]
        stt_public = {**stt, "token": "", "token_endpoint": "", "remote_consent_endpoint": "",
                      "download_directory": str(self.stt_model_root(user_id)),
                      "token_configured": bool(stt["token"]),
                      "token_required": stt["provider"] == "openai_compatible" and bool(api_key_service(stt["endpoint"])),
                      "remote_consent": stt["provider"] == "openai_compatible" and not _is_loopback(stt["endpoint"]) and stt["remote_consent_endpoint"] == stt["endpoint"]}
        from verwrity.ai.dictate_draft import configuration_hash
        ocr_ready = readiness(value["ocr"])
        receipt = value["ocr_test"]
        ocr_ready["tested"] = receipt.get("configuration") == configuration_hash(value["ocr"]) and receipt.get("passed") is True
        if ocr_ready["tested"] and ocr_ready["configured"]:
            ocr_ready["message"] = "The sample JPEG test passed for these saved settings."
        ocr = value["ocr"]
        ocr_public = {**ocr, "token": "", "token_endpoint": "", "token_provider": "", "remote_consent_endpoint": "",
            "token_configured": bool(ocr["token"]), "remote": ocr["provider"] in REMOTE_OCR,
            "remote_consent": ocr["provider"] in REMOTE_OCR and ocr["remote_consent_endpoint"] == ocr["endpoint"],
            "readiness": ocr_ready, "download_directory": "" if ocr["provider"] in REMOTE_OCR else str(managed_directory(self.root, user_id, ocr["provider"]))}
        return {"ocr": ocr_public, "stt": stt_public, "tts": {
            **tts,
            "google_api_key": "",
            "google_api_key_configured": bool(tts["google_api_key"]),
            "kokoro_model_ready": ready,
            "remote_consent_provider": "",
        }, "llm": {
            **llm,
            "token": "",
            "token_endpoint": "",
            "token_standard": "",
            "token_configured": bool(llm["token"]),
            "remote_consent": (not _is_loopback(str(llm["endpoint"]))
                               and llm["remote_consent_endpoint"] == llm["endpoint"]),
            "remote_consent_endpoint": "",
        }}

    def _save(self, user_id: str, key: str, values: dict[str, object]) -> None:
        path = self._path(user_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        saved = self.load(user_id)
        saved[key] = values
        with NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, prefix=".ai-models-", delete=False) as temporary:
            json.dump(saved, temporary, ensure_ascii=False, indent=2)
            temporary.write("\n")
            temporary.flush()
            temp_path = Path(temporary.name)
        temp_path.chmod(0o600)
        temp_path.replace(path)

    def update_ocr(self, user_id: str, values: object) -> dict[str, object]:
        if not isinstance(values, dict):
            raise ValueError("Provide OCR settings.")
        current = self.load(user_id)["ocr"]
        updated = checked_settings(values)
        same = (current["provider"], current["endpoint"]) == (updated["provider"], updated["endpoint"])
        token = updated["token"]
        updated["token"] = token or (current["token"] if same else "")
        if values.get("forget_token") is True or updated["provider"] not in REMOTE_OCR:
            updated["token"] = ""
        updated["token_endpoint"] = updated["endpoint"] if updated["token"] else ""
        updated["token_provider"] = updated["provider"] if updated["token"] else ""
        updated["remote_consent_endpoint"] = current["remote_consent_endpoint"] if same else ""
        if "remote_consent" in values:
            if type(values["remote_consent"]) is not bool:
                raise ValueError("Online OCR consent must be checked explicitly.")
            updated["remote_consent_endpoint"] = updated["endpoint"] if values["remote_consent"] and updated["provider"] in REMOTE_OCR else ""
        self._save(user_id, "ocr", updated)
        return self.public(user_id)["ocr"]

    def update_llm(self, user_id: str, values: object, registry: LLMRegistry) -> dict[str, object]:
        if not isinstance(values, dict):
            raise ValueError("Invalid LLM settings")
        current = self.load(user_id)["llm"]
        standard = values.get("standard", current["standard"])
        if not isinstance(standard, str):
            raise ValueError("Choose a supported LLM API standard")
        registry.get(standard)
        endpoint = values.get("endpoint", current["endpoint"])
        model = values.get("model", current["model"])
        if not isinstance(endpoint, str) or not endpoint.strip() or len(endpoint) > 2048:
            raise ValueError("Enter a valid model endpoint URL")
        if not isinstance(model, str) or len(model) > 256:
            raise ValueError("Enter a model name up to 256 characters")
        endpoint, model = normalize_endpoint(endpoint.strip().rstrip("/"), standard), model.strip()
        parsed = urlparse(endpoint)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
            raise ValueError("Enter a valid HTTP or HTTPS model endpoint URL")
        try:
            parsed.port
        except ValueError as error:
            raise ValueError("Enter a valid model endpoint port") from error
        if parsed.query or parsed.fragment:
            raise ValueError("Enter a base endpoint URL without query parameters or fragments")
        if parsed.scheme == "http" and not _is_loopback(endpoint):
            raise ValueError("Non-local model endpoints must use HTTPS")
        token = values.get("token", "")
        if not isinstance(token, str) or len(token) > 4096:
            raise ValueError("Invalid API token")
        token_matches_configuration = (current["token_endpoint"] == endpoint
                                       and current["token_standard"] == standard)
        saved_token = current["token"] if token_matches_configuration else ""
        updated = {"standard": standard, "endpoint": endpoint, "model": model,
                   "token": token.strip() or saved_token,
                   "token_endpoint": endpoint if token.strip() else current["token_endpoint"],
                   "token_standard": standard if token.strip() else current["token_standard"],
                   "remote_consent_endpoint": current["remote_consent_endpoint"]}
        if values.get("forget_token") is True:
            updated["token"] = ""
            updated["token_endpoint"] = endpoint
            updated["token_standard"] = standard
        elif token.strip():
            updated["token"] = token.strip()
            updated["token_endpoint"] = endpoint
            updated["token_standard"] = standard
        elif not token_matches_configuration:
            updated["token"] = ""
            updated["token_endpoint"] = endpoint
            updated["token_standard"] = standard
        if "remote_consent" in values:
            if not isinstance(values["remote_consent"], bool):
                raise ValueError("Remote manuscript consent must be checked explicitly")
            updated["remote_consent_endpoint"] = endpoint if values["remote_consent"] else ""
        if not _is_loopback(endpoint) and updated["remote_consent_endpoint"] != endpoint:
            raise ValueError("Acknowledge that this remote model endpoint receives the selected project text over the internet")
        self._save(user_id, "llm", updated)
        return self.public(user_id)["llm"]

    def update_stt(self, user_id: str, values: object, registry: STTRegistry) -> dict[str, object]:
        if not isinstance(values, dict):
            raise ValueError("Invalid speech-to-text settings")
        current = self.load(user_id)["stt"]
        updated = dict(current)
        for key in ("provider", "model_path", "device", "compute_type", "language", "shortcut", "endpoint", "model"):
            if key in values:
                if not isinstance(values[key], str) or len(values[key]) > (4096 if key == "model_path" else 2048):
                    raise ValueError("Invalid speech-to-text " + key.replace("_", " "))
                updated[key] = values[key].strip()
        if updated["shortcut"] not in (*SHORTCUTS, ""):
            raise ValueError("Choose a supported dictation shortcut")
        if updated["device"] not in {"cpu", "cuda"} or updated["compute_type"] not in {"default", "int8", "float16", "float32"}:
            raise ValueError("Choose a supported transcription device and compute type")
        if updated["language"] and not re.fullmatch(r"[a-z]{2,3}", updated["language"]):
            raise ValueError("Use a two or three letter language code, or leave it blank for detection")
        provider = registry.get(updated["provider"])
        updated["endpoint"] = checked_endpoint(updated["endpoint"])
        token = values.get("token", "")
        if not isinstance(token, str) or len(token) > 4096 or "\r" in token or "\n" in token:
            raise ValueError("Invalid transcription API token")
        if current["token_endpoint"] != updated["endpoint"] or values.get("forget_token") is True:
            updated["token"] = ""
        if token.strip() and values.get("forget_token") is not True:
            updated["token"] = token.strip()
        updated["token_endpoint"] = updated["endpoint"]
        if "remote_consent" in values:
            if not isinstance(values["remote_consent"], bool):
                raise ValueError("Online audio consent must be checked explicitly")
            updated["remote_consent_endpoint"] = updated["endpoint"] if values["remote_consent"] else ""
        provider.validate(updated)
        if updated["provider"] == "openai_compatible" and values.get("forget_token") is not True:
            require_api_key(updated)
        if provider.is_remote(updated) and updated["remote_consent_endpoint"] != updated["endpoint"]:
            raise ValueError("Acknowledge that this online endpoint receives your recorded audio over the internet")
        self._save(user_id, "stt", updated)
        return self.public(user_id)["stt"]

    def model_root(self, user_id: str) -> Path:
        """Return the user-scoped app-managed directory for downloaded models."""
        self._path(user_id)  # Validate the user identifier before building a path.
        return self.root / user_id / "ai_models" / "kokoro-v1.0"

    def stt_model_root(self, user_id: str) -> Path:
        """Keep the displayed default and actual download destination aligned."""
        self._path(user_id)
        return (self.root / user_id / "ai_models" / "whisper").resolve()

    def update_tts(self, user_id: str, values: object, registry: TTSRegistry) -> dict[str, object]:
        if not isinstance(values, dict):
            raise ValueError("Invalid text-to-speech settings")
        current = self.load(user_id)["tts"]
        provider = values.get("provider", current["provider"])
        if not isinstance(provider, str) or provider not in {choice["id"] for choice in registry.choices()}:
            raise ValueError("Choose a supported text-to-speech provider")
        updated = dict(current)
        updated["provider"] = provider
        for key in ("voice", "device", "model_path", "voices_path", "google_api_key", "google_voice", "edge_voice"):
            if key in values:
                if not isinstance(values[key], str) or len(values[key]) > 4096:
                    raise ValueError(f"Invalid {key.replace('_', ' ')}")
                updated[key] = values[key].strip()
        if "speed" in values:
            speed = values["speed"]
            if isinstance(speed, bool) or not isinstance(speed, (int, float)) or not 0.5 <= speed <= 2.0:
                raise ValueError("Speaking speed must be between 0.5 and 2.0")
            updated["speed"] = float(speed)
        if "device" in values and updated["device"] not in {"cpu", "cuda"}:
            raise ValueError("Choose CPU or CUDA")
        if "remote_consent" in values:
            if not isinstance(values["remote_consent"], bool):
                raise ValueError("Remote text consent must be checked explicitly")
            if values["remote_consent"]:
                updated["remote_consent_provider"] = provider
            elif updated["remote_consent_provider"] == provider:
                updated["remote_consent_provider"] = ""
        if registry.get(provider).is_remote and updated["remote_consent_provider"] != provider:
            raise ValueError("Acknowledge that the selected remote provider receives manuscript text over the internet")
        updated["remote_consent"] = updated["remote_consent_provider"] == provider
        self._save(user_id, "tts", updated)
        return self.public(user_id)["tts"]
