"""Explicit draft review requests. Recovery lives in browser IndexedDB, not archives."""

from copy import deepcopy
import base64
import json
from flask import Blueprint, Response, current_app, jsonify, request
from verwrity.ai.draft_audio import AudioImportError, IMPORT_PROTOCOL, MAX_IMPORT_BYTES, prepare_audio

from verwrity.ai.dictate_draft import (CLEANUP_PROTOCOL, cleanup_prompt, configuration_hash, review_cleanup,
    vocabulary, vocabulary_prompt, validate_vocabulary)
from verwrity.ai.llm import LLMConfigurationError, LLMRequestError, _is_loopback
from verwrity.analysis.wiki import manuscript_hash
from verwrity.project.files import PROJECT_LOCK
from verwrity.web.services.workspace import active_store

draft_blueprint = Blueprint("dictate_draft", __name__)


@draft_blueprint.after_request
def private_response(response):
    response.headers["Cache-Control"] = "no-store"
    return response


@draft_blueprint.get("/ai/dictate-draft")
def context():
    with PROJECT_LOCK:
        store = active_store()
        store.ensure_current()
        project = store.get()
        from verwrity.analysis.import_vocabulary import project_terms
        terms = project_terms(project)
        result = {"project_id": str(project.project_id), "title": project.title, "source_hash": manuscript_hash(project),
            "terms": terms, "cleanup_protocol": CLEANUP_PROTOCOL, "audio_import_protocol": IMPORT_PROTOCOL}
    settings = current_app.extensions["ai_settings"]
    user = current_app.config["USER_ID"]
    result["settings"] = settings.public(user)
    result["configurations"] = {key: configuration_hash(settings.load(user)[key]) for key in ("stt", "llm")}
    return jsonify(result)


@draft_blueprint.post("/ai/dictate-draft/audio")
def import_audio():
    # Only local conversion happens here. No provider call, manuscript input,
    # temporary upload file, or project lock held during decoding.
    with PROJECT_LOCK:
        store = active_store()
        store.ensure_current()
        if request.headers.get("X-Verwrity-Project") != str(store.get().project_id):
            return jsonify(error="The active project changed. Reopen Dictate draft before importing audio."), 409
    if request.content_length and request.content_length > MAX_IMPORT_BYTES:
        return jsonify(error="Choose an audio file of at most 24 MiB."), 400
    data = request.stream.read(MAX_IMPORT_BYTES + 1)
    try:
        sections = prepare_audio(data)
        first = next(sections)
    except AudioImportError as error:
        return jsonify(error=str(error)), 400
    def stream():
        def packet(section):
            return json.dumps({"audio": base64.b64encode(section.audio).decode("ascii"),
                "start": section.start, "end": section.end, "quiet": section.quiet}) + "\n"
        try:
            yield packet(first)
            for section in sections:
                yield packet(section)
            yield '{"done":true}\n'
        except AudioImportError as error:
            yield json.dumps({"error": str(error)}) + "\n"
        finally:
            sections.close()
    return Response(stream(), mimetype="application/x-ndjson")


@draft_blueprint.post("/ai/dictate-draft/<action>")
def review(action):
    if action not in {"cleanup", "vocabulary"}:
        return jsonify(error="Unknown draft review action."), 404
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify(error="Provide a draft review request."), 400
    configured = current_app.extensions["ai_settings"].load(current_app.config["USER_ID"])["llm"]
    if data.get("configuration") != configuration_hash(configured):
        return jsonify(error="LLM settings changed. Reopen Dictate draft before requesting review."), 409
    if not _is_loopback(configured["endpoint"]) and (configured["remote_consent_endpoint"] != configured["endpoint"]
            or data.get("consent_endpoint") != configured["endpoint"]):
        return jsonify(error="Consent to draft text/vocabulary processing at this exact LLM endpoint first."), 403
    try:
        with PROJECT_LOCK:
            store = active_store()
            store.ensure_current()
            project = store.get()
            if data.get("project_id") != str(project.project_id):
                return jsonify(error="The active project changed; the review buffer is retained."), 409
            if action == "vocabulary":
                if data.get("source_hash") != manuscript_hash(project):
                    return jsonify(error="The saved manuscript changed. Reopen the panel before suggesting vocabulary."), 409
                project = deepcopy(project)
        if action == "cleanup":
            terms = vocabulary(data.get("terms", []))
            prompt = cleanup_prompt(data.get("text"), data.get("previous", ""), terms)
        else:
            prompt, sources = vocabulary_prompt(project)
        # No project lock is held during a potentially long provider call.
        client = current_app.extensions["llm_registry"].get(configured["standard"])
        raw = client.complete(configured["endpoint"], configured["model"], configured["token"], prompt)
        result = (review_cleanup(data["text"], terms, raw) if action == "cleanup" else
            {"terms": validate_vocabulary(raw, sources), "source_hash": data["source_hash"]})
        return jsonify(result)
    except (ValueError, LLMConfigurationError):
        return jsonify(error="Draft review input or model edits were rejected. Raw text is retained; check limits and retry explicitly."), 400
    except Exception as error:
        # Do not include provider messages, prompts, text or vocabulary in logs.
        current_app.logger.warning("Draft review failed (%s)", type(error).__name__)
        return jsonify(error="Draft review failed. Raw text is retained; retry explicitly when ready."), 502
