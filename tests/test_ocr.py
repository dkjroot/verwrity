"""OCR stays view-only; synthetic image/video and provider fixtures only."""
from copy import deepcopy
from dataclasses import replace
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
from unittest.mock import Mock
from types import SimpleNamespace
from contextlib import nullcontext
from uuid import uuid4
import base64
import json
import unittest

from verwrity.ai.ocr import OCRRegistry, OCRRequest, OCRResult, OCRError, cleanup_prompt, checked_settings, review_corrections, transcription
from verwrity.ai.ocr_capture import candidate, capture_video, read_image, select_frames, transform
from verwrity.ai.settings import UserAISettings
from verwrity.domain.story import StoryProject
from verwrity.project.library import ProjectLibrary
from verwrity.project.store import ProjectStore
from verwrity.web.app import create_app

try:
    from PIL import Image, ImageDraw
except ImportError:
    Image = None


def image_bytes(color="white", text="Typewritten manuscript. A small synthetic page."):
    image = Image.new("RGB", (640, 800), color)
    draw = ImageDraw.Draw(image)
    for i in range(12):
        draw.text((50, 50 + i * 40), text, fill="black")
    output = BytesIO(); image.save(output, format="PNG")
    return output.getvalue()


@unittest.skipUnless(Image, "Install ocr-import for image/video tests")
class CaptureTests(unittest.TestCase):
    def test_orientation_crop_bounds_and_original_preservation(self):
        raw = image_bytes(); image = read_image(raw)
        before = image.tobytes()
        result = transform(image, {"crop": [.1, .1, .9, .9], "rotation": 90})
        self.assertEqual(result.size, (640, 512))
        self.assertEqual(image.tobytes(), before)
        for crop in ([1, 0, 0, 1], [0, 0, 1, 2], [0, 0, float("nan"), 1]):
            with self.assertRaises(OCRError): transform(image, {"crop": crop})
        with self.assertRaises(OCRError): read_image(b"not an image")

    def test_stable_pages_and_repeated_presentation_retained(self):
        a, b = read_image(image_bytes("white")), read_image(image_bytes("#aaa"))
        frames = [candidate(image.copy(), index * .25) for index, image in enumerate([a] * 8 + [b] * 8 + [a] * 8)]
        result = list(select_frames(frames))
        stable = [p for p in result if not p["uncertain"]]
        self.assertEqual(len(stable), 3)
        self.assertEqual(len({p["id"] for p in stable}), 3)
        self.assertEqual([p["start"] for p in stable], [0, 2, 4])
        self.assertTrue(all(len(p["variants"]) <= 3 for p in result))

    def test_short_unstable_interval_is_visible_and_progress_passes_through(self):
        frames = [candidate(read_image(image_bytes("white")), 0), {"progress": 0},
            candidate(read_image(image_bytes("#aaa")), .25)]
        result = list(select_frames(frames))
        self.assertIn({"progress": 0}, result)
        pages = [p for p in result if "id" in p]
        self.assertEqual(len(pages), 1)
        self.assertTrue(pages[0]["uncertain"])

    def test_real_pyav_video_decode(self):
        try: import av
        except ImportError: self.skipTest("Install PyAV for actual video decode")
        video = BytesIO()
        with av.open(video, "w", format="mp4") as container:
            stream = container.add_stream("mpeg4", rate=8); stream.width = 640; stream.height = 800; stream.pix_fmt = "yuv420p"
            for color in ("white", "#aaa", "white"):
                image = read_image(image_bytes(color))
                for _ in range(16):
                    for packet in stream.encode(av.VideoFrame.from_image(image)): container.mux(packet)
            for packet in stream.encode(): container.mux(packet)
        video.seek(0)
        results = list(capture_video(video))
        self.assertEqual(len([p for p in results if "id" in p and not p["uncertain"]]), 3)
        self.assertTrue(any("progress" in p for p in results))
        self.assertTrue(any(p.get("similar_to") for p in results), "repeated pages are flagged, never dropped")


class ProviderTests(unittest.TestCase):
    def test_model_front_matter_is_not_manuscript_and_rotation_is_only_a_warning(self):
        raw = "---\nprimary_language: en\nis_rotation_valid: false\nrotation_correction: 90\nis_table: false\nis_diagram: false\n---\nOriginal typo.\n"
        text, warnings = transcription(raw)
        self.assertEqual(text, "Original typo.\n"); self.assertTrue(warnings)
        self.assertEqual(transcription("---\nA scene separator.\n")[0], "---\nA scene separator.\n")
        with self.assertRaises(OCRError): transcription("---\nis_rotation_valid: true\ntruncated")

    def test_local_loader_is_offline_and_reuses_loaded_model(self):
        class Inputs(dict):
            def to(self, device): return self
        with TemporaryDirectory() as directory:
            path = Path(directory); (path / "config.json").write_text('{"model_type":"qwen2_5_vl"}')
            processor = Mock(); processor.apply_chat_template.return_value = Inputs(input_ids=SimpleNamespace(shape=(1, 2)))
            processor.decode.return_value = "Original typewritten text."
            model = Mock(); model.to.return_value = model; model.eval.return_value = model
            model.generate.return_value = [[0, 0, 1, 2, 3]]
            processor_class = Mock(); processor_class.from_pretrained.return_value = processor
            model_class = Mock(); model_class.from_pretrained.return_value = model
            fake_torch = SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: True, empty_cache=lambda: None),
                bfloat16="bf16", float32="f32", inference_mode=nullcontext)
            with patch.dict("sys.modules", {"torch": fake_torch, "transformers": SimpleNamespace(
                    AutoProcessor=processor_class, AutoModelForImageTextToText=model_class)}), patch("verwrity.ai.ocr._CACHE", None):
                provider = OCRRegistry().get("olmocr"); settings = checked_settings({"model_path": directory})
                for _ in range(2):
                    fake_image = Mock(); fake_image.copy.return_value = fake_image
                    self.assertEqual(provider.recognize(OCRRequest("test", fake_image), settings).text, "Original typewritten text.")
                model_class.from_pretrained.assert_called_once()
                self.assertTrue(model_class.from_pretrained.call_args.kwargs["local_files_only"])
                self.assertFalse(model_class.from_pretrained.call_args.kwargs["trust_remote_code"])
                self.assertTrue(processor_class.from_pretrained.call_args.kwargs["local_files_only"])

    def test_corrections_are_anchored_bounded_and_ocr_specific(self):
        text = "1eft rnodern inter-\nnal."
        result = review_corrections(text, json.dumps({"edits": [
            {"before": "1eft", "after": "left"}, {"before": "rnodern", "after": "modern"},
            {"before": "inter-\nnal", "after": "internal"},
            {"before": "absent", "after": "invented"},
            {"before": text, "after": "A completely rewritten manuscript."}]}))
        self.assertEqual(result["text"], "left modern internal.")
        self.assertEqual(result["skipped_edits"], 2)
        self.assertEqual(review_corrections("cat cat", '{"edits":[{"before":"cat","after":"cats"}]}')["text"], "cat cat")
        self.assertEqual(review_corrections("a b", json.dumps({"edits": [{"before": "a b", "after": "ab"}, {"before": "a b", "after": "a\nb"}]}))["text"], "a b")

    def test_local_path_required_and_unregistered_provider_rejected(self):
        with self.assertRaises(OCRError): OCRRegistry().get("cloud")
        with self.assertRaises(OCRError): checked_settings({"provider": "cloud"})
        with self.assertRaises(OCRError):
            OCRRegistry().get("olmocr").recognize(OCRRequest(str(uuid4()), None), checked_settings({}))

    def test_ocr_prompt_does_not_use_speech_instructions(self):
        prompt = cleanup_prompt("An original typo.")
        self.assertIn("Preserve original typos", prompt)
        self.assertIn("image is NOT supplied", prompt)
        self.assertNotIn("VOICE TRANSCRIPTION", prompt)
        with self.assertRaises(OCRError): cleanup_prompt("x" * 20001)


@unittest.skipUnless(Image, "Install ocr-import for routes")
class RouteTests(unittest.TestCase):
    def setUp(self):
        temp = TemporaryDirectory(); self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        project = StoryProject.demo(); project.scenes[0].text = "Canonical prose remains untouched."
        self.app = create_app(ProjectStore(project))
        self.app.config.update(TESTING=True, PROJECT_DRAFT_ROOT=self.root / "drafts", PROJECT_LIBRARY=ProjectLibrary(self.root))
        self.app.extensions["ai_settings"] = UserAISettings(self.root)
        self.client = self.app.test_client(); self.context = self.client.get("/ai/ocr").json
        self.page = str(uuid4())
        self.data = {"project_id": self.context["project_id"], "page_id": self.page,
            "configuration": self.context["configurations"]["ocr"],
            "image": base64.b64encode(image_bytes()).decode()}

    def test_settings_are_user_scoped_and_survive_other_provider_saves(self):
        result = self.client.post("/ai/ocr/settings", json={"project_id": self.context["project_id"],
            "settings": {"provider": "paddleocr", "model_path": "C:/installed/weights", "device": "cuda"}})
        self.assertEqual(result.status_code, 200)
        settings = self.app.extensions["ai_settings"]
        settings.update_llm("local-user", {"endpoint": "localhost:8080", "model": "test"}, self.app.extensions["llm_registry"])
        self.assertEqual(settings.load("local-user")["ocr"]["provider"], "paddleocr")
        self.assertNotIn("ocr", json.dumps(next(iter(self.app.config["PROJECT_STORES"].values())).get().scenes[0].text))

    def test_ocr_is_view_only_and_uses_registry_without_holding_project_lock(self):
        store = next(iter(self.app.config["PROJECT_STORES"].values())); before = deepcopy(store.get())
        class Fake:
            def recognize(inner, request, settings):
                self.assertEqual(request.page_id, self.page)
                return OCRResult(request.page_id, "Literal <tag> &amp; text.", "synthetic")
        self.app.extensions["ocr_registry"].providers["olmocr"] = Fake()
        response = self.client.post("/ai/ocr/recognize", json=self.data)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["text"], "Literal <tag> &amp; text.")
        self.assertIsNone(response.json["confidence"])
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        self.assertEqual(store.get(), before)

    def test_bad_input_and_stale_settings_do_not_call_provider(self):
        with patch.object(type(self.app.extensions["ocr_registry"].get("olmocr")), "recognize") as call:
            for change in ({"project_id": str(uuid4())}, {"configuration": "stale"}, {"page_id": "invalid"}, {"image": "!"}):
                self.assertGreaterEqual(self.client.post("/ai/ocr/recognize", json={**self.data, **change}).status_code, 400)
            call.assert_not_called()

    def test_still_image_and_adjustment_need_no_model(self):
        response = self.client.post("/ai/ocr/import", data=image_bytes(), headers={
            "X-Verwrity-Project": self.context["project_id"], "X-Verwrity-Media": "image"})
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json["image"])
        response = self.client.post("/ai/ocr/preview", json={**self.data, "adjustment": {"rotation": 90}})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(read_image(base64.b64decode(response.json["image"])).size, (800, 640))

    def test_profile_preview_and_inference_use_the_same_dimensions_without_mutating_source(self):
        settings = {"longest_edge": 512, "mode": "gray", "contrast": 1.2}
        payload = {**self.data, "adjustment": {"profile": settings}}
        preview = self.client.post("/ai/ocr/preview", json=payload)
        self.assertEqual(preview.status_code, 200)
        self.assertEqual((preview.json["width"], preview.json["height"]), (410, 512))
        class Fake:
            def recognize(inner, request, settings):
                self.assertEqual(request.image.size, (410, 512))
                return OCRResult(request.page_id, "Unchanged raw OCR.", "fixture")
        self.app.extensions["ocr_registry"].providers["olmocr"] = Fake()
        self.assertEqual(self.client.post("/ai/ocr/recognize", json=payload).status_code, 200)
        self.assertEqual(read_image(base64.b64decode(self.data["image"])).size, (640, 800))
        invalid = self.client.post("/ai/ocr/preview", json={**self.data, "adjustment": {"profile": {"longest_edge": 999999}}})
        self.assertEqual(invalid.status_code, 400)

    def test_video_decode_failure_is_reported_without_claiming_completion(self):
        response = self.client.post("/ai/ocr/import", data=b"broken", headers={
            "X-Verwrity-Project": self.context["project_id"], "X-Verwrity-Media": "video"})
        packets = [json.loads(line) for line in response.data.decode().splitlines()]
        self.assertTrue(packets[-1].get("error"))
        self.assertFalse(any(p.get("done") for p in packets))

    def test_cleanup_only_sends_raw_ocr_and_requires_exact_remote_consent(self):
        settings = self.app.extensions["ai_settings"]
        settings.update_llm("local-user", {"endpoint": "localhost:8080", "model": "test"}, self.app.extensions["llm_registry"])
        context = self.client.get("/ai/ocr").json
        payload = {"project_id": context["project_id"], "page_id": self.page,
            "configuration": context["configurations"]["llm"], "text": "rnodern prose"}
        client = self.app.extensions["llm_registry"].get("openai_compatible")
        with patch.object(type(client), "complete", return_value='{"edits":[{"before":"rnodern","after":"modern"}]}') as call:
            result = self.client.post("/ai/ocr/cleanup", json=payload)
            self.assertEqual(result.status_code, 200)
            self.assertEqual(result.json["text"], "modern prose")
            self.assertNotIn("Canonical prose", call.call_args.args[3])
            self.assertNotIn(self.data["image"], call.call_args.args[3])
        settings.update_llm("local-user", {"endpoint": "https://example.test/v1", "model": "test", "remote_consent": True}, self.app.extensions["llm_registry"])
        context = self.client.get("/ai/ocr").json
        result = self.client.post("/ai/ocr/cleanup", json={**payload, "configuration": context["configurations"]["llm"]})
        self.assertEqual(result.status_code, 403)
