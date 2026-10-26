"""Synthetic audio import, local conversion bounds, and private HTTP boundaries."""
from io import BytesIO
import importlib.util
import base64
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
import wave

from verwrity.ai.draft_audio import AudioImportError, AudioSection, prepare_audio
from verwrity.ai.settings import UserAISettings
from verwrity.domain.story import StoryProject
from verwrity.project.library import ProjectLibrary
from verwrity.project.store import ProjectStore
from verwrity.web.app import create_app


def recording(seconds=1, rate=8000, channels=2):
    output = BytesIO()
    with wave.open(output, "wb") as audio:
        audio.setparams((channels, 2, rate, 0, "NONE", "not compressed"))
        audio.writeframes(b"\x00\x08" * channels * int(seconds * rate))
    return output.getvalue()


@unittest.skipUnless(importlib.util.find_spec("av"), "optional PyAV audio import extra")
class AudioConversionTest(unittest.TestCase):
    def test_stereo_wav_resamples_to_complete_mono_16k_wav(self):
        with wave.open(BytesIO(next(prepare_audio(recording())).audio), "rb") as audio:
            self.assertEqual((audio.getnchannels(), audio.getsampwidth(), audio.getframerate(), audio.getnframes()),
                (1, 2, 16000, 16000))
            self.assertTrue(any(audio.readframes(16000)))

    def test_real_common_compressed_formats_and_containers(self):
        import av
        for format, codec, rate in [("mp3", "libmp3lame", 48000), ("mp4", "aac", 48000),
                ("adts", "aac", 48000), ("flac", "flac", 48000), ("ogg", "libopus", 48000),
                ("webm", "libopus", 48000), ("aiff", "pcm_s16be", 48000), ("asf", "wmav2", 44100)]:
            with self.subTest(format=format):
                output = BytesIO()
                with av.open(output, "w", format=format) as container:
                    stream = container.add_stream(codec, rate=rate)
                    stream.layout = "mono"
                    stream.bit_rate = 64000
                    frame = av.AudioFrame(format="s16", layout="mono", samples=rate // 10)
                    frame.sample_rate = rate
                    frame.planes[0].update(b"\x00\x08" * (rate // 10))
                    for packet in stream.encode(frame): container.mux(packet)
                    for packet in stream.encode(): container.mux(packet)
                with wave.open(BytesIO(next(prepare_audio(output.getvalue())).audio), "rb") as decoded:
                    self.assertEqual(decoded.getframerate(), 16000)
                    self.assertGreater(decoded.getnframes(), 0)

    def test_invalid_empty_and_oversized_audio_are_rejected(self):
        for data in [b"", b"private words not audio", recording(0)]:
            with self.subTest(size=len(data)), self.assertRaises(AudioImportError): list(prepare_audio(data))
        with patch("verwrity.ai.draft_audio.MAX_IMPORT_BYTES", 8), self.assertRaises(AudioImportError):
            list(prepare_audio(b"x" * 9))

    def test_recording_over_thirty_minutes_streams_bounded_contiguous_sections(self):
        # A low-rate WAV keeps the source small while genuinely decoding >30 min.
        end, count, maximum = 0, 0, 0
        for section in prepare_audio(recording(31 * 60, rate=1000, channels=1)):
            self.assertEqual(section.start, end)
            self.assertLessEqual(section.end - section.start, 45.3)
            with wave.open(BytesIO(section.audio), "rb") as audio:
                self.assertEqual(audio.getnframes(), round((section.end - section.start) * 16000))
            end, count = section.end, count + 1
            maximum = max(maximum, len(section.audio))
        self.assertEqual(end, 31 * 60)
        self.assertGreater(count, 40)
        self.assertLess(maximum, 2 * 1024 * 1024)

    def test_chunk_limit_reports_partial_completion_instead_of_silent_truncation(self):
        with patch("verwrity.ai.draft_audio.MAX_SECTION_SECONDS", 1), patch("verwrity.ai.draft_audio.MAX_SECTIONS", 2):
            sections = prepare_audio(recording(4))
            self.assertEqual(next(sections).start, 0)
            self.assertGreater(next(sections).end, 2)
            with self.assertRaisesRegex(AudioImportError, "500 sections"):
                next(sections)

    def test_missing_optional_decoder_has_install_instructions(self):
        with patch.dict("sys.modules", {"av": None}), self.assertRaisesRegex(AudioImportError, "audio-import"):
            list(prepare_audio(recording()))


class AudioImportRouteTest(unittest.TestCase):
    def setUp(self):
        temp = TemporaryDirectory(); self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        self.app = create_app(ProjectStore(StoryProject.demo()))
        self.app.config["PROJECT_DRAFT_ROOT"] = root / "drafts"
        self.app.config["PROJECT_LIBRARY"] = ProjectLibrary(root)
        self.app.extensions["ai_settings"] = UserAISettings(root)
        self.client = self.app.test_client()
        self.context = self.client.get("/ai/dictate-draft").json
        self.headers = {"X-Verwrity-Project": self.context["project_id"]}

    def test_local_conversion_is_project_bound_no_store_and_never_calls_providers(self):
        self.assertEqual(self.context["audio_import_protocol"], "wav-sections-v2")
        with patch("verwrity.web.routes.dictate_draft.prepare_audio", return_value=(section for section in [AudioSection(b"RIFF synthetic", 0, 1, False)])) as convert, \
                patch("verwrity.ai.llm.HTTPChatClient.complete") as llm, \
                patch("verwrity.ai.stt.FasterWhisperProvider.transcribe") as stt:
            response = self.client.post("/ai/dictate-draft/audio", data=b"encoded file", headers=self.headers,
                content_type="application/octet-stream")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.mimetype, "application/x-ndjson")
        packets = [json.loads(line) for line in response.data.splitlines()]
        self.assertEqual(base64.b64decode(packets[0]["audio"]), b"RIFF synthetic")
        self.assertEqual(packets[-1], {"done": True})
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        convert.assert_called_once_with(b"encoded file")
        llm.assert_not_called(); stt.assert_not_called()

    def test_stale_project_invalid_audio_and_size_do_not_disclose_input(self):
        with patch("verwrity.web.routes.dictate_draft.prepare_audio") as convert:
            self.assertEqual(self.client.post("/ai/dictate-draft/audio", data=b"private", headers={
                "X-Verwrity-Project": "stale"}).status_code, 409)
            convert.assert_not_called()
        with patch("verwrity.web.routes.dictate_draft.MAX_IMPORT_BYTES", 8), \
                patch("verwrity.web.routes.dictate_draft.prepare_audio") as convert:
            self.assertEqual(self.client.post("/ai/dictate-draft/audio", data=b"123456789", headers=self.headers).status_code, 400)
            convert.assert_not_called()
        with patch("verwrity.web.routes.dictate_draft.prepare_audio", side_effect=AudioImportError("No decodable audio.")):
            response = self.client.post("/ai/dictate-draft/audio", data=b"private audio", headers=self.headers)
            self.assertEqual(response.status_code, 400)
            self.assertNotIn("private", response.text)

    def test_late_decode_failure_keeps_prefix_and_reports_incomplete_stream(self):
        def sections():
            yield AudioSection(b"RIFF prefix", 0, 1, False)
            raise AudioImportError("The remaining audio could not be decoded.")
        with patch("verwrity.web.routes.dictate_draft.prepare_audio", return_value=sections()):
            response = self.client.post("/ai/dictate-draft/audio", data=b"encoded", headers=self.headers)
            packets = [json.loads(line) for line in response.data.splitlines()]
        self.assertEqual(response.status_code, 200)
        self.assertEqual(base64.b64decode(packets[0]["audio"]), b"RIFF prefix")
        self.assertEqual(packets[1], {"error": "The remaining audio could not be decoded."})
        self.assertNotIn({"done": True}, packets)

    def test_closing_response_closes_decoder_before_remaining_audio(self):
        closed = []
        def sections():
            try:
                yield AudioSection(b"RIFF prefix", 0, 1, False)
                self.fail("A cancelled response must not decode the next section")
            finally:
                closed.append(True)
        with patch("verwrity.web.routes.dictate_draft.prepare_audio", return_value=sections()):
            response = self.client.post("/ai/dictate-draft/audio", data=b"encoded", headers=self.headers, buffered=False)
            self.assertFalse(closed)
            response.close()
            self.assertEqual(closed, [True])
