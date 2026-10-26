"""Text-to-speech provider boundary and first local/remote implementations."""

from __future__ import annotations

import asyncio
import base64
import json
import os
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from threading import Lock
from typing import Mapping, Protocol
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


class TTSConfigurationError(ValueError):
    """The selected provider is missing valid configuration."""


def _keep_kokoro_onset(samples, sample_rate: int, trim_audio):
    """Trim Kokoro's generated padding while retaining a safety lead-in.

    kokoro-onnx's default trim boundary can start inside a quiet consonant.
    Use its boundary detector, but keep 250 ms before that boundary so the
    first phoneme survives and the audio stream has a short silent lead-in.
    """
    _, (head, tail) = trim_audio(samples)
    start = max(0, int(head) - round(sample_rate * 0.25))
    end = min(len(samples), int(tail) + round(sample_rate * 0.08))
    if end <= start:
        return samples
    return samples[start:end]


_KOKORO_LOCK = Lock()
_KOKORO_MODELS: dict[tuple[str, str, str], object] = {}


@dataclass(frozen=True)
class SynthesisOptions:
    """Common speech controls shared across TTS providers."""

    voice: str
    speed: float = 1.0
    language: str | None = None


class TTSProvider(Protocol):
    provider_id: str
    display_name: str
    is_remote: bool
    media_type: str

    def prepare(self, settings: Mapping[str, object]) -> tuple[SynthesisOptions, Mapping[str, object]]: ...

    def synthesize(self, text: str, options: SynthesisOptions, configuration: Mapping[str, object]) -> bytes: ...


@dataclass(frozen=True)
class KokoroLocalProvider:
    """Local ONNX Kokoro inference; this implementation never accesses a network."""

    provider_id: str = "kokoro_local"
    display_name: str = "Kokoro (local)"
    is_remote: bool = False
    media_type: str = "audio/wav"

    def prepare(self, settings: Mapping[str, object]) -> tuple[SynthesisOptions, Mapping[str, object]]:
        return (
            SynthesisOptions(voice=str(settings["voice"]), speed=float(settings["speed"])),
            {key: settings[key] for key in ("model_path", "voices_path", "device")},
        )

    def synthesize(self, text: str, options: SynthesisOptions, configuration: Mapping[str, object]) -> bytes:
        model_path = Path(str(configuration.get("model_path", "")).strip())
        voices_path = Path(str(configuration.get("voices_path", "")).strip())
        if not model_path.is_file() or not voices_path.is_file():
            raise TTSConfigurationError("Choose readable Kokoro model and voice files in AI Models.")
        device = configuration.get("device", "cpu")
        if device not in {"cpu", "cuda"}:
            raise TTSConfigurationError("Choose CPU or CUDA for local Kokoro inference.")
        try:
            from kokoro_onnx import Kokoro
            from kokoro_onnx.trim import trim as trim_audio
            import soundfile as sf
        except ImportError as error:
            raise TTSConfigurationError("Install Verwrity's optional local-tts dependencies to use Kokoro.") from error

        # kokoro-onnx reads this setting when it creates its ONNX session. No model
        # lookup/download is performed by Verwrity; files must already exist locally.
        with _KOKORO_LOCK:
            provider_name = "CUDAExecutionProvider" if device == "cuda" else "CPUExecutionProvider"
            cache_key = (str(model_path), str(voices_path), provider_name)
            model = _KOKORO_MODELS.get(cache_key)
            if model is None:
                previous_provider = os.environ.get("ONNX_PROVIDER")
                os.environ["ONNX_PROVIDER"] = provider_name
                try:
                    model = Kokoro(str(model_path), str(voices_path))
                finally:
                    if previous_provider is None:
                        os.environ.pop("ONNX_PROVIDER", None)
                    else:
                        os.environ["ONNX_PROVIDER"] = previous_provider
                _KOKORO_MODELS[cache_key] = model
            samples, sample_rate = model.create(
                text,
                voice=options.voice,
                speed=options.speed,
                lang=options.language or "en-us",
                trim=False,
            )
            samples = _keep_kokoro_onset(samples, sample_rate, trim_audio)
        audio = BytesIO()
        sf.write(audio, samples, sample_rate, format="WAV")
        return audio.getvalue()


@dataclass(frozen=True)
class GoogleCloudTTSProvider:
    """Google Cloud TTS using an API key supplied by the user."""

    provider_id: str = "google_cloud_tts"
    display_name: str = "Google Cloud TTS"
    is_remote: bool = True
    media_type: str = "audio/wav"

    def prepare(self, settings: Mapping[str, object]) -> tuple[SynthesisOptions, Mapping[str, object]]:
        return (
            SynthesisOptions(voice=str(settings["google_voice"]), speed=float(settings["speed"])),
            {"api_key": settings["google_api_key"]},
        )

    def synthesize(self, text: str, options: SynthesisOptions, configuration: Mapping[str, object]) -> bytes:
        api_key = str(configuration.get("api_key", "")).strip()
        if not api_key:
            raise TTSConfigurationError("Add a Google Cloud TTS API key in AI Models.")
        if len(text.encode("utf-8")) > 5000:
            raise TTSConfigurationError("Google Cloud TTS reads up to 5,000 UTF-8 bytes at a time.")
        body = json.dumps({
            "input": {"text": text},
            "voice": {"languageCode": options.language or "en-US", "name": options.voice},
            "audioConfig": {"audioEncoding": "LINEAR16", "speakingRate": options.speed},
        }).encode("utf-8")
        request = Request(
            "https://texttospeech.googleapis.com/v1/text:synthesize",
            data=body,
            headers={"Content-Type": "application/json; charset=utf-8", "x-goog-api-key": api_key},
            method="POST",
        )
        try:
            with urlopen(request, timeout=60) as response:
                payload = json.loads(response.read())
        except (HTTPError, URLError, TimeoutError, OSError, ValueError) as error:
            # Never include the URL or request body in an error returned to the UI.
            raise RuntimeError("Google Cloud TTS could not synthesize this scene.") from error
        try:
            return base64.b64decode(payload["audioContent"], validate=True)
        except (KeyError, ValueError, TypeError) as error:
            raise RuntimeError("Google Cloud TTS returned an invalid audio response.") from error


@dataclass(frozen=True)
class EdgeTTSProvider:
    """Keyless remote synthesis using the community edge-tts client."""

    provider_id: str = "edge_tts"
    display_name: str = "Microsoft Edge TTS (remote, no API key)"
    is_remote: bool = True
    media_type: str = "audio/mpeg"

    def prepare(self, settings: Mapping[str, object]) -> tuple[SynthesisOptions, Mapping[str, object]]:
        return SynthesisOptions(voice=str(settings["edge_voice"]), speed=float(settings["speed"])), {}

    def synthesize(self, text: str, options: SynthesisOptions, configuration: Mapping[str, object]) -> bytes:
        try:
            import edge_tts
        except ImportError as error:
            raise TTSConfigurationError("Install Verwrity's optional remote-tts dependencies to use Edge TTS.") from error

        async def generate() -> bytes:
            communicate = edge_tts.Communicate(
                text,
                options.voice,
                rate=f"{round((options.speed - 1) * 100):+d}%",
            )
            chunks = []
            async for item in communicate.stream():
                if item.get("type") == "audio":
                    chunks.append(item["data"])
            return b"".join(chunks)

        try:
            audio = asyncio.run(generate())
        except (OSError, RuntimeError, ValueError) as error:
            raise RuntimeError("Microsoft Edge TTS could not synthesize this scene.") from error
        if not audio:
            raise RuntimeError("Microsoft Edge TTS returned no audio.")
        return audio


class TTSRegistry:
    """Small extension point: register one provider implementation per stable ID."""

    def __init__(self, providers: list[TTSProvider] | None = None) -> None:
        defaults = [KokoroLocalProvider(), GoogleCloudTTSProvider(), EdgeTTSProvider()]
        self._providers = {provider.provider_id: provider for provider in (providers or defaults)}

    def get(self, provider_id: str) -> TTSProvider:
        try:
            return self._providers[provider_id]
        except KeyError as error:
            raise TTSConfigurationError("Choose a supported text-to-speech provider in AI Models.") from error

    def choices(self) -> list[dict[str, str | bool]]:
        return [{"id": provider.provider_id, "name": provider.display_name, "remote": provider.is_remote} for provider in self._providers.values()]
