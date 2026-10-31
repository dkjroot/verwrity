"""Explicit OCR capture/review. Canonical project data is never written here."""
from dataclasses import asdict
from tempfile import TemporaryFile
import base64
import binascii
import json
from uuid import UUID
from io import BytesIO
from queue import Queue, Empty
from threading import Thread
from time import monotonic
import re
from datetime import datetime, timezone

from flask import Blueprint, Response, current_app, jsonify, request

from verwrity.ai.ocr import OCRRequest, OCRError, REMOTE_OCR, cleanup_prompt, review_corrections
from verwrity.ai.ocr_remote import require_remote_consent
from verwrity.ai.ocr_models import readiness, install
from verwrity.ai.ocr_worker import OCRWorker
from verwrity.ai.ocr_capture import (MAX_UPLOAD, MAX_IMAGE_BYTES, capture_video,
    read_image, encoded, transform, fingerprint, similarity, sharpness)
from verwrity.ai.dictate_draft import configuration_hash
from verwrity.ai.llm import LLMConfigurationError, LLMRequestError, _is_loopback
from verwrity.project.files import PROJECT_LOCK
from verwrity.web.services.workspace import active_store

ocr_blueprint = Blueprint("ocr", __name__)


def worker():
    if "ocr_worker" not in current_app.extensions:
        current_app.extensions["ocr_worker"] = OCRWorker()
    return current_app.extensions["ocr_worker"]


def event_response(events):
    logger = current_app.logger
    def stream():
        try:
            for event in events:
                yield json.dumps(event) + "\n"
        except OCRError as error:
            yield json.dumps({"error": str(error)}) + "\n"
        except Exception as error:
            logger.warning("OCR operation stopped (%s)", type(error).__name__)
            yield json.dumps({"error": "OCR operation stopped unexpectedly. Images and completed review are retained; retry explicitly."}) + "\n"
        finally:
            events.close()
    return Response(stream(), mimetype="application/x-ndjson", headers={"X-Accel-Buffering": "no"})


def waiting_events(call, logger, stage):
    """Progress while awaiting a text provider/download; never invent token progress."""
    results = Queue(1)
    def run():
        try: results.put({"result": call()})
        except Exception as error:
            if isinstance(error, (OCRError, LLMConfigurationError, LLMRequestError)):
                message = str(error)
                logger.warning("%s failed: %s", stage, message)
            else:
                message = "Provider operation failed; existing settings and text are retained."
                logger.warning("%s failed (%s)", stage, type(error).__name__)
            results.put({"error": message})
    Thread(target=run, daemon=True).start()
    start, logged = monotonic(), -15
    logger.info("%s started", stage)
    while True:
        elapsed = round(monotonic() - start, 1)
        try:
            result = results.get(timeout=1)
            logger.info("%s %s after %.1fs", stage, "completed" if "result" in result else "failed", elapsed)
            yield {**result, "elapsed": elapsed}
            return
        except Empty:
            if elapsed - logged >= 15:
                logger.info("%s: request pending (%.1fs elapsed)", stage, elapsed); logged = elapsed
            yield {"stage": stage, "elapsed": elapsed, "tokens": None}


SAMPLE_TEXT = "Verwrity OCR test.\nThe quick brown fox jumps over the lazy dog.\nPage 123."


def sample_jpeg():
    from PIL import Image, ImageDraw, ImageFont
    image = Image.new("RGB", (1000, 260), "white")
    try: font = ImageFont.truetype("DejaVuSans.ttf", 30)
    except OSError: font = ImageFont.load_default(size=30)
    ImageDraw.Draw(image).multiline_text((35, 40), SAMPLE_TEXT, font=font, fill="black", spacing=22)
    data = BytesIO(); image.save(data, format="JPEG", quality=95)
    return data.getvalue()


@ocr_blueprint.get("/ai/models/ocr/sample.jpg")
def sample():
    return Response(sample_jpeg(), mimetype="image/jpeg")


@ocr_blueprint.get("/ai/models/ocr")
def model_settings():
    settings, user = settings_store()
    return jsonify({**settings.public(user)["ocr"], "configuration": configuration_hash(settings.load(user)["ocr"])})


@ocr_blueprint.post("/ai/models/ocr")
def update_model_settings():
    settings, user = settings_store()
    try:
        value = settings.update_ocr(user, request.get_json(silent=True))
        return jsonify({**value, "configuration": configuration_hash(settings.load(user)["ocr"])})
    except ValueError as error:
        return jsonify(error=str(error)), 400
    except OSError:
        return jsonify(error="Could not save OCR settings; existing settings are retained."), 500


@ocr_blueprint.post("/ai/models/ocr/download")
def download():
    settings, user = settings_store()
    data = request.get_json(silent=True) or {}
    configured = settings.load(user)["ocr"]
    if data.get("configuration") != configuration_hash(configured):
        return jsonify(error="OCR settings changed. Reopen AI Models before downloading."), 409
    if configured["provider"] in REMOTE_OCR:
        return jsonify(error="Online OCR does not need a local model download."), 400
    def perform():
        path = install(settings.root, user, configured["provider"])
        current = settings.load(user)["ocr"]
        if (current["provider"] != configured["provider"] or current["device"] != configured["device"] or
                current["model_path"] not in {"", configured["model_path"], path}):
            raise OCRError("Download completed, but OCR settings changed. Choose the downloaded directory explicitly; newer settings were retained.")
        value = settings.update_ocr(user, {**configured, "model_path": path})
        return {**value, "configuration": configuration_hash(settings.load(user)["ocr"])}
    return event_response(waiting_events(perform, current_app.logger, "OCR model download"))


@ocr_blueprint.post("/ai/models/ocr/test")
def test_model():
    settings, user = settings_store()
    configured = settings.load(user)["ocr"]
    data = request.get_json(silent=True) or {}
    if data.get("configuration") != configuration_hash(configured):
        return jsonify(error="OCR settings changed. Save settings before testing."), 409
    status = readiness(configured)
    if not status["configured"]:
        return jsonify(error=status["message"]), 400
    engine = worker()
    page = OCRRequest(str(UUID(int=1)), read_image(sample_jpeg()), max_tokens=256)
    def events():
        for event in engine.run(page, configured):
            if "result" in event:
                actual = event["result"]["text"]
                normalize = lambda text: re.sub(r"[^a-z0-9]", "", text.casefold())
                event["result"] = {"text": actual, "expected": SAMPLE_TEXT,
                    "matched": normalize(actual) == normalize(SAMPLE_TEXT), "elapsed": event["elapsed"]}
                if configuration_hash(settings.load(user)["ocr"]) == configuration_hash(configured):
                    settings._save(user, "ocr_test", {"configuration": configuration_hash(configured),
                        "passed": event["result"]["matched"], "timestamp": datetime.now(timezone.utc).isoformat()})
            yield event
    return event_response(events())


@ocr_blueprint.post("/ai/models/llm/test")
def test_llm():
    settings, user = settings_store()
    configured = settings.load(user)["llm"]
    if not configured["model"]:
        return jsonify(error="Save a model name in LLM settings first."), 400
    if not _is_loopback(configured["endpoint"]) and configured["remote_consent_endpoint"] != configured["endpoint"]:
        return jsonify(error="Save consent for this exact LLM endpoint before testing."), 403
    client = current_app.extensions["llm_registry"].get(configured["standard"])
    def perform():
        text = "".join(client.stream(configured["endpoint"], configured["model"], configured["token"], "Reply with exactly: Verwrity test OK. No other text."))
        if not text.strip():
            raise LLMRequestError("The model endpoint returned no text response.")
        return {"text": text[:1000], "matched": text.strip() == "Verwrity test OK.", "model": configured["model"]}
    return event_response(waiting_events(perform, current_app.logger, "LLM configuration test"))


@ocr_blueprint.after_request
def private(response):
    response.headers["Cache-Control"] = "no-store"
    return response


def project_id(expected=None):
    with PROJECT_LOCK:
        store = active_store()
        store.ensure_current()
        identity = str(store.get().project_id)
        if expected is not None and expected != identity:
            raise OCRError("The active project changed. Reopen OCR import; retained work is unchanged.")
        return identity


def settings_store():
    return current_app.extensions["ai_settings"], current_app.config["USER_ID"]


def snapshot():
    settings, user = settings_store()
    saved = settings.load(user)
    from verwrity.analysis.import_vocabulary import project_terms
    with PROJECT_LOCK:
        identity = project_id()
        terms = project_terms(active_store().get())
    return {"project_id": identity, "terms": terms, "settings": settings.public(user),
        "configurations": {key: configuration_hash(saved[key]) for key in ("ocr", "llm")}}


@ocr_blueprint.get("/ai/ocr")
def context():
    return jsonify(snapshot())


@ocr_blueprint.post("/ai/ocr/similarity")
def compare_images():
    data = request.get_json(silent=True) or {}
    try:
        project_id(data.get("project_id", ""))
        items = data.get("pages")
        if not isinstance(items, list) or len(items) > 500:
            raise OCRError("Compare up to 500 captures.")
        references = data.get("references", [])
        if not isinstance(references, list) or len(references) > 500:
            raise OCRError("Compare against up to 500 captures.")
        for reference in references:
            if not isinstance(reference, dict) or not isinstance(reference.get("fingerprint"), str) or len(reference["fingerprint"]) > 6000:
                raise OCRError("Provide valid reference fingerprints.")
        matches, kept = [], list(references)
        threshold = data.get("threshold", .75)
        if type(threshold) not in {float, int} or not .5 <= threshold <= 1:
            raise OCRError("Similarity threshold must be between 50% and 100%.")
        for item in items:
            if not isinstance(item, dict) or not isinstance(item.get("fingerprint"), str) or len(item["fingerprint"]) > 6000:
                raise OCRError("Provide valid capture fingerprints.")
            scores = [(similarity(item["fingerprint"], previous["fingerprint"]), previous["id"]) for previous in kept]
            score, identity = max(scores, default=(0, None))
            matches.append({"id": item.get("id"), "similar_to": identity, "similarity": score})
            if score < threshold or item.get("keep"):
                kept.append(item)
        return jsonify(matches=matches)
    except OCRError as error:
        return jsonify(error=str(error)), 400


@ocr_blueprint.post("/ai/ocr/settings")
def save_settings():
    data = request.get_json(silent=True)
    try:
        if not isinstance(data, dict):
            raise OCRError("Provide OCR settings.")
        project_id(data.get("project_id", ""))
        settings, user = settings_store()
        settings.update_ocr(user, data.get("settings"))
        return jsonify(snapshot())
    except OCRError as error:
        return jsonify(error=str(error)), 400
    except OSError:
        return jsonify(error="OCR settings could not be saved. Existing settings are retained."), 500


@ocr_blueprint.post("/ai/ocr/import")
def import_source():
    request.max_content_length = MAX_UPLOAD
    try:
        project_id(request.headers.get("X-Verwrity-Project", ""))
        kind = request.headers.get("X-Verwrity-Media")
        if kind == "image":
            image = read_image(request.stream.read(MAX_IMAGE_BYTES + 1))
            image.thumbnail((3200, 3200))
            return jsonify(image=encoded(image), fingerprint=fingerprint(image), fingerprint_version=2, sharpness=sharpness(image), width=image.width, height=image.height)
        if kind != "video":
            raise OCRError("Choose a video or still image.")
        rotation = request.headers.get("X-Verwrity-Rotation", "0")
        if rotation not in {"0", "90", "180", "270"}:
            raise OCRError("Choose a whole-video rotation: 0, 90, 180 or 270 degrees.")
        # Spool encoded input to an anonymous temporary file, bounded independently
        # of decoded frames. It is removed on completion/disconnect/error.
        source = TemporaryFile()
        try:
            total = 0
            while block := request.stream.read(1024 * 1024):
                total += len(block)
                if total > MAX_UPLOAD:
                    raise OCRError("Video import supports files up to 1 GiB; split larger recordings.")
                source.write(block)
            source.seek(0)
        except BaseException:
            source.close()
            raise
        def stream():
            try:
                for capture in capture_video(source, int(rotation)):
                    yield json.dumps(capture) + "\n"
                yield '{"done":true}\n'
            except OCRError as error:
                yield json.dumps({"error": str(error)}) + "\n"
            finally:
                source.close()
        response = Response(stream(), mimetype="application/x-ndjson")
        response.call_on_close(source.close)
        return response
    except OCRError as error:
        return jsonify(error=str(error)), 400


def page_image(data):
    value = data.get("image")
    if not isinstance(value, str) or len(value) > MAX_IMAGE_BYTES * 4 // 3 + 4:
        raise OCRError("Provide a page image of at most 24 MiB.")
    try:
        image = read_image(base64.b64decode(value, validate=True))
    except (ValueError, binascii.Error):
        raise OCRError("Invalid page image.") from None
    return transform(image, data.get("adjustment", {}))


@ocr_blueprint.post("/ai/ocr/<action>")
def process(action):
    if action not in {"recognize", "preview", "cleanup"}:
        return jsonify(error="Unknown OCR action."), 404
    request.max_content_length = 36 * 1024 * 1024 if action in {"recognize", "preview"} else 256 * 1024
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify(error="Provide a page request."), 400
    try:
        project_id(data.get("project_id", ""))
        page_id = str(UUID(data.get("page_id", "")))
        settings, user = settings_store()
        configured = settings.load(user)["llm" if action == "cleanup" else "ocr"]
        if action != "preview" and data.get("configuration") != configuration_hash(configured):
            return jsonify(error="Provider settings changed. Reopen OCR import before retrying."), 409
        if action == "preview":
            image = page_image(data)
            return jsonify(image=encoded(image), fingerprint=fingerprint(image), fingerprint_version=2, sharpness=sharpness(image), width=image.width, height=image.height)
        if action == "recognize":
            if configured["provider"] in REMOTE_OCR:
                require_remote_consent(configured)
                if data.get("consent_endpoint") != configured["endpoint"]:
                    return jsonify(error="Confirm sending selected manuscript images off your computer, outside Verwrity's control, to the configured OCR endpoint."), 403
            page = OCRRequest(page_id, page_image(data))
            if request.headers.get("X-Verwrity-Progress") == "1":
                return event_response(worker().run(page, configured))
            provider = current_app.extensions["ocr_registry"].get(configured["provider"])
            result = provider.recognize(page, configured)
            return jsonify(asdict(result))
        if not _is_loopback(configured["endpoint"]) and (
                configured["remote_consent_endpoint"] != configured["endpoint"] or
                data.get("consent_endpoint") != configured["endpoint"]):
            return jsonify(error="Acknowledge OCR text processing at the exact configured LLM endpoint first."), 403
        from verwrity.ai.dictate_draft import vocabulary
        terms = vocabulary(data.get("terms", []))
        prompt = cleanup_prompt(data.get("text"), terms)
        client = current_app.extensions["llm_registry"].get(configured["standard"])
        if request.headers.get("X-Verwrity-Progress") == "1":
            def correct():
                raw = client.complete(configured["endpoint"], configured["model"], configured["token"], prompt)
                return review_corrections(data["text"], raw, terms)
            return event_response(waiting_events(correct, current_app.logger, "OCR text correction provider"))
        raw = client.complete(configured["endpoint"], configured["model"], configured["token"], prompt)
        return jsonify(review_corrections(data["text"], raw, terms))
    except (ValueError, TypeError) as error:
        return jsonify(error=str(error) if isinstance(error, OCRError) else "Invalid OCR input or model response; source retained."), 400
    except Exception:
        return jsonify(error="OCR review failed. Source and raw text are retained; retry explicitly."), 502
