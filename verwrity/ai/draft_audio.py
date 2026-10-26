"""Streaming local audio-file conversion, without inference or persistent files."""

from array import array
from dataclasses import dataclass
from io import BytesIO
import sys
import wave

MAX_IMPORT_BYTES = 24 * 1024 * 1024
IMPORT_RATE = 16000
IMPORT_PROTOCOL = "wav-sections-v2"
MAX_SECTIONS = 500
MAX_SECTION_SECONDS = 45


class AudioImportError(ValueError):
    pass


@dataclass(frozen=True)
class AudioSection:
    audio: bytes
    start: float
    end: float
    quiet: bool


def _wav(data):
    output = BytesIO()
    with wave.open(output, "wb") as result:
        result.setnchannels(1)
        result.setsampwidth(2)
        result.setframerate(IMPORT_RATE)
        result.writeframes(data)
    return output.getvalue()


def _sections(blocks):
    # Match the microphone's 4096-sample quiet/maximum-duration boundaries.
    pending, partial = bytearray(), bytearray()
    total, start, silence, speech, emitted = 0, 0, 0, False, 0
    def section():
        nonlocal start, silence, speech, emitted
        emitted += 1
        if emitted > MAX_SECTIONS:
            raise AudioImportError("This dictation reached 500 sections. Completed sections are retained; start a fresh dictation for the remainder.")
        result = AudioSection(_wav(pending), start / IMPORT_RATE, total / IMPORT_RATE, not speech)
        pending.clear()
        start, silence, speech = total, 0, False
        return result
    def push(block):
        nonlocal total, silence, speech
        values = array("h", block)
        if sys.byteorder != "little": values.byteswap()
        total += len(values)
        pending.extend(block)
        if sum(value * value for value in values) / len(values) > (.003 * 32768) ** 2:
            silence, speech = 0, True
        else:
            silence += len(values)
    for data in blocks:
        partial.extend(data)
        while len(partial) >= 8192:
            block = partial[:8192]
            del partial[:8192]
            push(block)
            if (total - start >= IMPORT_RATE * MAX_SECTION_SECONDS or
                    total - start >= IMPORT_RATE * 8 and silence >= IMPORT_RATE * 1.2):
                yield section()
    if partial: push(partial)
    if pending: yield section()


def prepare_audio(data: bytes):
    """Yield independent WAVs as decoding progresses; no recording-duration cap."""
    if not data or len(data) > MAX_IMPORT_BYTES:
        raise AudioImportError("Choose a non-empty audio file of at most 24 MiB.")
    try:
        import av
    except ImportError:
        raise AudioImportError("Audio file import needs PyAV. Install it with pip install -e '.[audio-import]', then restart Verwrity.") from None
    try:
        resampler = av.AudioResampler(format="s16", layout="mono", rate=IMPORT_RATE)
        with av.open(BytesIO(data), mode="r", options={"protocol_whitelist": "pipe"}) as source:
            def blocks():
                for frame in source.decode(audio=0):
                    frame.pts = None
                    for converted in resampler.resample(frame):
                        yield bytes(converted.planes[0])[:converted.samples * 2]
                for converted in resampler.resample(None):
                    yield bytes(converted.planes[0])[:converted.samples * 2]
            found = False
            for section in _sections(blocks()):
                found = True
                yield section
            if not found:
                raise AudioImportError("The file contains no decodable audio.")
    except (AudioImportError, GeneratorExit):
        raise
    except Exception:
        raise AudioImportError("This file could not be decoded as audio. Try exporting it as WAV, MP3 or M4A.") from None
