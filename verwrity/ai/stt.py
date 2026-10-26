"""Explicit audio transcription; providers never receive project text."""

from __future__ import annotations

import json
import os
import logging
from time import perf_counter
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from threading import Lock
from typing import Protocol
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, build_opener
from uuid import uuid4

from verwrity.ai.llm import _is_loopback, _NoRedirect, normalize_endpoint

# Set before any optional runtime can import the Hub's cached configuration.
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
logger = logging.getLogger(__name__)

MAX_AUDIO_BYTES = 24 * 1024 * 1024
AUDIO_TYPES = {"audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "mp4", "audio/wav": "wav", "audio/x-wav": "wav", "audio/mpeg": "mp3"}
SHORTCUTS = ("ControlRight", "AltRight", "ShiftRight", "F8", "F9", "F10")
LOCAL_MODELS = ("tiny.en", "base.en", "small.en", "tiny", "base", "small", "medium", "large-v3")


def api_key_service(endpoint: str) -> str:
    """Known hosted APIs require authentication; custom servers choose their own."""
    return {"api.groq.com": "Groq (including its free tier)", "api.openai.com": "OpenAI"}.get(urlparse(endpoint).hostname, "")


def require_api_key(settings):
    service = api_key_service(settings["endpoint"])
    if service and not settings["token"].strip():
        raise STTConfigurationError(f"{service} requires an API key. Add it in AI Models → Speech-to-text before using dictation.")


class STTConfigurationError(ValueError):
    """A user-actionable transcription configuration problem."""


class STTRequestError(RuntimeError):
    """A transcription failed, without disclosing audio or secrets."""


def _decode_audio(audio: AudioInput):
    """Decode bounded in-memory audio with external media protocols disabled."""
    import av
    import numpy as np

    samples = []
    count = 0
    resampler = av.AudioResampler(format="s16", layout="mono", rate=16000)
    with av.open(BytesIO(audio.data), mode="r", options={"protocol_whitelist": "pipe"}) as container:
        for frame in container.decode(audio=0):
            frame.pts = None
            for converted in resampler.resample(frame):
                count += converted.samples
                if count > 16000 * 5 * 60:
                    raise STTRequestError("Please dictate passages of five minutes or less.")
                samples.append(converted.to_ndarray().reshape(-1))
        for converted in resampler.resample(None):
            count += converted.samples
            if count > 16000 * 5 * 60:
                raise STTRequestError("Please dictate passages of five minutes or less.")
            samples.append(converted.to_ndarray().reshape(-1))
    return np.concatenate(samples).astype(np.float32) / 32768 if samples else np.array([], dtype=np.float32)


def checked_endpoint(value: str) -> str:
    if "://" in value and not value.lower().startswith(("http://", "https://")):
        raise STTConfigurationError("Enter an HTTP or HTTPS transcription endpoint.")
    endpoint = normalize_endpoint(value.strip().rstrip("/"), "openai_compatible")
    parsed = urlparse(endpoint)
    try:
        parsed.port
    except ValueError as error:
        raise STTConfigurationError("Enter a valid transcription endpoint port.") from error
    if (parsed.scheme not in {"http", "https"} or not parsed.hostname
            or parsed.username or parsed.password or parsed.query or parsed.fragment
            or (parsed.scheme == "http" and not _is_loopback(endpoint))):
        raise STTConfigurationError("Use a loopback HTTP URL or an HTTPS API base URL without credentials, query parameters, or fragments.")
    return endpoint


@dataclass(frozen=True)
class AudioInput:
    data: bytes
    media_type: str


class TranscriptionProvider(Protocol):
    provider_id: str
    display_name: str

    def is_remote(self, settings: dict) -> bool: ...
    def validate(self, settings: dict) -> None: ...
    def transcribe(self, audio: AudioInput, settings: dict) -> str: ...


class FasterWhisperProvider:
    provider_id = "faster_whisper"
    display_name = "Faster Whisper (offline, CPU or CUDA)"

    def __init__(self):
        self._lock = Lock()
        self._model = None
        self._configuration = None

    def is_remote(self, settings):
        return False

    def validate(self, settings):
        if settings["device"] not in {"cpu", "cuda"}:
            raise STTConfigurationError("Choose CPU or CUDA.")
        if settings["compute_type"] not in {"default", "int8", "float16", "float32"}:
            raise STTConfigurationError("Choose a supported compute type.")

    def transcribe(self, audio, settings):
        self.validate(settings)
        path = Path(settings["model_path"])
        # Requiring a complete local tokenizer prevents the runtime's fallback
        # from downloading a tokenizer during an otherwise offline request.
        if not settings["model_path"] or not all((path / name).is_file() for name in ("model.bin", "config.json", "tokenizer.json")):
            raise STTConfigurationError("Choose a complete Faster Whisper model folder or download a model in AI Models first.")
        os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
        try:
            from faster_whisper import WhisperModel
        except ImportError as error:
            raise STTConfigurationError("Install local recognition with pip install -e '.[local-stt]'.") from error
        configuration = (str(path.resolve()), settings["device"], settings["compute_type"])
        try:
            started = perf_counter()
            logger.info("Local STT: waiting for inference slot (device=%s, compute=%s)", settings["device"], settings["compute_type"])
            # One cached model bounds memory and serializes competing local jobs.
            with self._lock:
                if self._configuration != configuration:
                    logger.info("Local STT: loading model")
                    self._model = None
                    self._configuration = None
                    self._model = WhisperModel(configuration[0], device=configuration[1], compute_type=configuration[2], local_files_only=True)
                    self._configuration = configuration
                    logger.info("Local STT: model loaded in %.2fs", perf_counter() - started)
                else:
                    logger.info("Local STT: reusing loaded model")
                logger.info("Local STT: decoding recording")
                waveform = _decode_audio(audio)
                if not waveform.size:
                    return ""
                logger.info("Local STT: recognizing %.2fs of audio", waveform.size / 16000)
                segments, _ = self._model.transcribe(waveform, language=settings["language"] or None, task="transcribe", vad_filter=True)
                text = " ".join(segment.text.strip() for segment in segments).strip()
                logger.info("Local STT: recognition finished in %.2fs (%d characters)", perf_counter() - started, len(text))
                return text
        except STTRequestError:
            raise
        except Exception as error:
            detail = str(error).lower()
            if any(name in detail for name in ("cublas", "cudnn", "cuda driver", "cuda runtime")):
                logger.error("Local STT: required CUDA/cuBLAS/cuDNN runtime libraries unavailable")
                raise STTConfigurationError("CUDA speech recognition could not load the required NVIDIA runtime libraries. Choose CPU with int8 in AI Models, or install the CUDA/cuBLAS/cuDNN libraries required by Faster Whisper.") from error
            if "compute type" in detail or "float16" in detail:
                logger.error("Local STT: unsupported device/compute combination")
                raise STTConfigurationError("The selected device does not support this compute type. Choose CPU with int8, or a compute type supported by your CUDA setup.") from error
            raise STTRequestError("Local transcription failed. Check the model folder, language, device, and compute type.") from error


class OpenAITranscriptionProvider:
    provider_id = "openai_compatible"
    display_name = "OpenAI-compatible transcription API (local or online)"

    def is_remote(self, settings):
        return not _is_loopback(checked_endpoint(settings["endpoint"]))

    def validate(self, settings):
        checked_endpoint(settings["endpoint"])
        if not settings["model"].strip():
            raise STTConfigurationError("Enter the transcription model name required by your server.")

    def transcribe(self, audio, settings):
        self.validate(settings)
        require_api_key(settings)
        endpoint = checked_endpoint(settings["endpoint"])
        if self.is_remote(settings) and settings["remote_consent_endpoint"] != endpoint:
            raise STTConfigurationError("Acknowledge the online audio disclosure in AI Models first.")
        boundary = "verwrity-" + uuid4().hex
        body = bytearray()
        for key, value in {"model": settings["model"], "response_format": "json", "language": settings["language"]}.items():
            if value:
                body.extend(f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n'.encode())
        extension = AUDIO_TYPES[audio.media_type]
        body.extend(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="dictation.{extension}"\r\nContent-Type: {audio.media_type}\r\n\r\n'.encode())
        body.extend(audio.data)
        body.extend(f"\r\n--{boundary}--\r\n".encode())
        headers = {"Content-Type": f"multipart/form-data; boundary={boundary}", "Accept": "application/json"}
        if settings["token"]:
            headers["Authorization"] = "Bearer " + settings["token"]
        request = Request(endpoint + "/audio/transcriptions", data=bytes(body), headers=headers, method="POST")
        try:
            started = perf_counter()
            logger.info("HTTP STT: uploading %d audio bytes; waiting for response (remote=%s, token_configured=%s)", len(audio.data), self.is_remote(settings), bool(settings["token"]))
            # Never forward audio or authentication through a redirect.
            with build_opener(_NoRedirect).open(request, timeout=300) as response:
                logger.info("HTTP STT: receiving transcription response")
                raw = response.read(1024 * 1024 + 1)
            if len(raw) > 1024 * 1024:
                raise STTRequestError("The transcription response was too large.")
            text = json.loads(raw)["text"]
            if not isinstance(text, str):
                raise ValueError("Invalid transcript")
            logger.info("HTTP STT: response parsed in %.2fs (%d characters)", perf_counter() - started, len(text))
            return text.strip()
        except HTTPError as error:
            logger.warning("HTTP STT: service returned HTTP %d", error.code)
            if error.code in {401, 403}:
                raise STTConfigurationError("The transcription service rejected authentication. Save a valid API key/token for this endpoint in AI Models. Free tiers may still require an API key.") from error
            if error.code == 429:
                raise STTRequestError("The transcription service's rate limit or quota was reached. Check your account limits and retry later.") from error
            if 300 <= error.code < 400:
                raise STTConfigurationError("The transcription endpoint redirected the request. Verwrity refused to forward your audio. Enter the service's final API base URL in AI Models.") from error
            raise STTRequestError(f"The transcription service returned HTTP {error.code}. Check the endpoint, model, and supported audio formats.") from error
        except (URLError, TimeoutError, OSError, ValueError, KeyError, TypeError) as error:
            logger.warning("HTTP STT: connection or response failed (%s)", type(error).__name__)
            raise STTRequestError("The transcription endpoint could not process the audio. Check its model, token, and supported audio formats.") from error


class STTRegistry:
    def __init__(self, providers=None):
        self.providers = {provider.provider_id: provider for provider in (providers if providers is not None else [FasterWhisperProvider(), OpenAITranscriptionProvider()])}

    def get(self, provider_id):
        try:
            return self.providers[provider_id]
        except KeyError as error:
            raise STTConfigurationError("Choose a supported speech-to-text provider.") from error

    def choices(self):
        return [{"id": provider.provider_id, "name": provider.display_name} for provider in self.providers.values()]


def download_whisper_model(model: str, root: Path) -> str:
    """Network access happens only through the explicit model-download action."""
    if model not in LOCAL_MODELS:
        raise STTConfigurationError("Choose a supported Whisper download.")
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    try:
        from huggingface_hub import snapshot_download
    except ImportError as error:
        raise STTConfigurationError("Install local recognition with pip install -e '.[local-stt]' before downloading.") from error
    try:
        logger.info("Whisper download: fetching %s model files", model)
        path = snapshot_download("Systran/faster-whisper-" + model, cache_dir=str(root), allow_patterns=["model.bin", "config.json", "tokenizer.json", "preprocessor_config.json", "vocabulary.*"], local_files_only=False, token=False)
    except Exception as error:
        raise STTRequestError("The Whisper model download failed. Check the connection and retry.") from error
    if not all((Path(path) / name).is_file() for name in ("model.bin", "config.json", "tokenizer.json")):
        raise STTRequestError("The downloaded model is incomplete; retry the download.")
    logger.info("Whisper download: required model files are present")
    return str(Path(path).resolve())
