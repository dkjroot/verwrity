"""Configuration, similarity and isolated progress regressions; no real weights."""
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
from io import BytesIO
import json
import time
import unittest

from verwrity.ai.ocr import OCRRequest, OCRError
from verwrity.ai.ocr_models import discovered_directory, model_issue
from verwrity.ai.ocr_worker import OCRWorker
from verwrity.ai.ocr_capture import fingerprint, similarity, transform, sharpness
from verwrity.ai.ocr_preprocess import ImageProfile
from verwrity.ai.settings import UserAISettings
from tests import test_ocr as base
from verwrity.web.routes.ocr import SAMPLE_TEXT


def synthetic_worker(incoming, outgoing):
    while True:
        request, settings = incoming.get()
        outgoing.put({"stage": "Loading synthetic model", "tokens": 0})
        if settings.get("wait"):
            time.sleep(30)
        outgoing.put({"stage": "Recognizing page", "tokens": 8})
        outgoing.put({"result": {"page_id": request.page_id, "text": "Synthetic result", "model": "fixture"}})


@unittest.skipUnless(base.Image, "Install Pillow for image profiles")
class ProfileTests(unittest.TestCase):
    def test_profile_size_tonal_effect_and_reversibility(self):
        source = base.read_image(base.image_bytes())
        before = source.tobytes()
        profile = {"longest_edge": 512, "brightness": 1.2, "contrast": 1.5,
            "sharpness": 2, "mode": "bw", "threshold": 160, "autocontrast": True}
        result = transform(source, {"profile": profile})
        self.assertEqual(result.size, (410, 512))
        self.assertEqual(set(result.convert("L").tobytes()), {0, 255})
        self.assertEqual(source.tobytes(), before, "profile preserves original pixels")
        self.assertEqual(transform(source, {}).tobytes(), before, "removing profile restores original")
        self.assertEqual(transform(source, {"profile": profile}).tobytes(), result.tobytes(), "reapply starts at source")
        self.assertEqual(transform(source, {"rotation": 90, "profile": profile}).size, (512, 410))

    def test_profile_rejects_unbounded_or_invalid_controls(self):
        for value in ([], {"longest_edge": 99999}, {"longest_edge": 512.5}, {"sharpness": float("nan")},
                {"brightness": True}, {"threshold": 0}, {"mode": "edges"}, {"autocontrast": "yes"}, {"unknown": 1}):
            with self.subTest(value=value), self.assertRaises(OCRError): ImageProfile.parse(value)

    def test_sharpness_prefers_unblurred_text(self):
        from PIL import ImageFilter
        source = base.read_image(base.image_bytes())
        self.assertGreater(sharpness(source), sharpness(source.filter(ImageFilter.GaussianBlur(3))))


class WorkerTests(unittest.TestCase):
    def test_separate_process_progress_cache_and_cancel(self):
        engine = OCRWorker(target=synthetic_worker); self.addCleanup(engine.stop)
        request = OCRRequest("fixture", None)
        events = list(engine.run(request, {"provider": "fixture", "device": "cpu"}))
        self.assertTrue(any(e.get("tokens") == 8 for e in events))
        self.assertEqual(events[-1]["result"]["text"], "Synthetic result")
        pid = engine.process.pid
        list(engine.run(request, {"provider": "fixture", "device": "cpu"}))
        self.assertEqual(engine.process.pid, pid, "worker is retained between pages")
        list(engine.run(request, {"provider": "mistral", "device": "cpu"}))
        self.assertNotEqual(engine.process.pid, pid, "switching providers releases the resident native worker")
        generator = engine.run(request, {"provider": "fixture", "device": "cpu", "wait": True})
        next(generator)
        with self.assertRaises(OCRError): next(engine.run(request, {"provider": "fixture", "device": "cpu"}))
        generator.close()
        self.assertIsNone(engine.process, "cancel releases the worker and its model memory")
        events = list(engine.run(request, {"provider": "fixture", "device": "cpu"}))
        self.assertIn("result", events[-1])


class DiscoveryTests(unittest.TestCase):
    def test_readme_location_discovered_without_settings_file_and_incomplete_rejected(self):
        with TemporaryDirectory() as directory:
            folder = Path(directory) / "models/olmocr2"; folder.mkdir(parents=True)
            (folder / "config.json").write_text('{"model_type":"qwen2_5_vl"}')
            self.assertFalse(discovered_directory(directory, "local-user", "olmocr"))
            for name in ("tokenizer.json", "tokenizer_config.json", "preprocessor_config.json", "model.safetensors"):
                (folder / name).write_text("fixture")
            self.assertEqual(discovered_directory(directory, "local-user", "olmocr"), str(folder.resolve()))
            settings = UserAISettings(directory)
            self.assertEqual(settings.load("local-user")["ocr"]["model_path"], str(folder.resolve()))
            settings.update_ocr("local-user", {"provider": "olmocr", "device": "cpu", "model_path": "explicit-missing-path"})
            self.assertEqual(settings.load("local-user")["ocr"]["model_path"], "explicit-missing-path", "never overwrite an explicit custom path")
            (folder / "model.safetensors.index.json").write_text('{"weight_map":{"x":"../../outside"}}')
            self.assertTrue(model_issue(folder, "olmocr"))


@unittest.skipUnless(base.Image, "Requires ocr-import")
class FeedbackRoutes(unittest.TestCase):
    setUp = base.RouteTests.setUp

    def test_llm_configuration_probe_uses_only_fixed_test_text(self):
        settings = self.app.extensions["ai_settings"]
        settings.update_llm("local-user", {"endpoint": "localhost:8080", "model": "fixture"}, self.app.extensions["llm_registry"])
        client = self.app.extensions["llm_registry"].get("openai_compatible")
        with patch.object(type(client), "complete", return_value="Verwrity test OK.") as call:
            response = self.client.post("/ai/models/llm/test", json={})
            events = [json.loads(line) for line in response.data.splitlines()]
        self.assertTrue(events[-1]["result"]["matched"])
        self.assertEqual(call.call_args.args[3], "Reply with exactly: Verwrity test OK. No other text.")
    def test_similarity_weights_text_and_retains_different_pages(self):
        from PIL import ImageDraw
        first = base.Image.new("RGB", (640, 800), "white")
        draw = ImageDraw.Draw(first)
        for i in range(12): draw.text((30, 30 + i * 50), "THE FIRST PAGE has words " * 3, fill="black")
        other = base.Image.new("RGB", first.size, "white")
        draw = ImageDraw.Draw(other)
        for i in range(8): draw.text((60, 40 + i * 75), "An entirely different paragraph and page.", fill="black")
        a, b = fingerprint(first), fingerprint(other)
        self.assertEqual(similarity(a, a), 1)
        self.assertLess(similarity(a, b), .95)
        payload = {"project_id": self.context["project_id"], "threshold": .95,
            "pages": [{"id": "one", "fingerprint": a}, {"id": "copy", "fingerprint": a}, {"id": "different", "fingerprint": b}]}
        result = self.client.post("/ai/ocr/similarity", json=payload)
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json["matches"][1]["similar_to"], "one")
        self.assertEqual(result.json["matches"][1]["similarity"], 1)
        self.assertLess(result.json["matches"][2]["similarity"], .95)

    def test_streamed_worker_and_sample_test_are_private_and_view_only(self):
        class Fake:
            def run(inner, page, settings):
                yield {"stage": "Loading model weights", "tokens": 0, "elapsed": 1}
                yield {"stage": "Recognizing page", "tokens": 8, "elapsed": 2}
                yield {"result": {"page_id": page.page_id, "text": SAMPLE_TEXT}, "elapsed": 3}
        self.app.extensions["ocr_worker"] = Fake()
        result = self.client.post("/ai/ocr/recognize", json=self.data, headers={"X-Verwrity-Progress": "1"})
        events = [json.loads(line) for line in result.data.splitlines()]
        self.assertEqual(events[1]["tokens"], 8)
        self.assertEqual(events[-1]["result"]["text"], SAMPLE_TEXT)
        self.assertEqual(self.client.get("/health").status_code, 200)
        with patch("verwrity.web.routes.ocr.readiness", return_value={"configured": True}):
            result = self.client.post("/ai/models/ocr/test", json={"configuration": self.context["configurations"]["ocr"]})
            events = [json.loads(line) for line in result.data.splitlines()]
        self.assertTrue(events[-1]["result"]["matched"])
        self.assertTrue(self.app.extensions["ai_settings"].public("local-user")["ocr"]["readiness"]["tested"])
        self.assertEqual(self.client.get("/ai/models/ocr/sample.jpg").mimetype, "image/jpeg")

    def test_explicit_download_selects_managed_directory_and_stale_settings_fail(self):
        state = self.client.get("/ai/models/ocr").json
        with patch("verwrity.web.routes.ocr.install", return_value="fixture-installed") as download:
            result = self.client.post("/ai/models/ocr/download", json={"configuration": state["configuration"]})
            events = [json.loads(line) for line in result.data.splitlines()]
            self.assertEqual(events[-1]["result"]["model_path"], "fixture-installed")
            download.assert_called_once()
        self.assertEqual(self.client.post("/ai/models/ocr/test", json={"configuration": "stale"}).status_code, 409)

    def test_video_quarter_turns_and_invalid_rotation(self):
        seen = []
        def capture(source, rotation):
            seen.append(rotation)
            yield {"progress": 1}
        headers = {"X-Verwrity-Project": self.context["project_id"], "X-Verwrity-Media": "video"}
        with patch("verwrity.web.routes.ocr.capture_video", side_effect=capture):
            for angle in ("0", "90", "180", "270"):
                response = self.client.post("/ai/ocr/import", data=b"video fixture", headers={**headers, "X-Verwrity-Rotation": angle})
                self.assertIn(b'"done":true', response.data)
        self.assertEqual(seen, [0, 90, 180, 270])
        self.assertEqual(self.client.post("/ai/ocr/import", data=b"fixture", headers={**headers, "X-Verwrity-Rotation": "45"}).status_code, 400)

    def test_real_video_rotation_applies_to_every_extracted_variant(self):
        try: import av
        except ImportError: self.skipTest("Install PyAV for video rotation test")
        from verwrity.ai.ocr_capture import capture_video, read_image
        import base64
        video = BytesIO()
        with av.open(video, "w", format="mp4") as output:
            stream = output.add_stream("mpeg4", rate=4); stream.width = 640; stream.height = 800; stream.pix_fmt = "yuv420p"
            image = read_image(base.image_bytes())
            for _ in range(8):
                for packet in stream.encode(av.VideoFrame.from_image(image)): output.mux(packet)
            for packet in stream.encode(): output.mux(packet)
        for angle, expected in ((0, (640, 800)), (90, (800, 640)), (180, (640, 800)), (270, (800, 640))):
            video.seek(0)
            captures = [c for c in capture_video(video, angle) if "id" in c]
            self.assertTrue(captures)
            for capture in captures:
                for variant in capture["variants"]:
                    self.assertEqual(read_image(base64.b64decode(variant["image"])).size, expected)

    def test_health_remains_responsive_while_isolated_worker_is_waiting(self):
        engine = OCRWorker(target=synthetic_worker); self.addCleanup(engine.stop)
        class Waiting:
            def run(inner, page, settings):
                return engine.run(page, {**settings, "wait": True})
        self.app.extensions["ocr_worker"] = Waiting()
        response = self.client.post("/ai/ocr/recognize", json=self.data, headers={"X-Verwrity-Progress": "1"}, buffered=False)
        iterator = iter(response.response)
        next(iterator)  # Initial stage (already obtained by the test client).
        next(iterator)  # Worker is executing, before the delayed result.
        started = time.monotonic()
        self.assertEqual(self.client.get("/health").status_code, 200)
        self.assertLess(time.monotonic() - started, .5)
        response.close()
        self.assertIsNone(engine.process)
