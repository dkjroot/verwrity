"""Explicit AI capability settings, project questions, and speech endpoints."""

import json
import re
from copy import deepcopy
from io import BytesIO
from uuid import UUID
from uuid import uuid4
from time import perf_counter
from urllib.error import HTTPError

from flask import Blueprint, Response, current_app, g, jsonify, request, send_file, session, stream_with_context
from werkzeug.exceptions import RequestEntityTooLarge
from itsdangerous import URLSafeTimedSerializer

from verwrity.ai.models import KokoroModelInstaller, ModelDownloadError
from verwrity.ai.dictate_draft import configuration_hash
from verwrity.ai.interrogation import prepare_alternatives, prepare_question, validate_evidence
from verwrity.ai.llm import LLMConfigurationError, LLMRequestError, _is_loopback, parse_answer
from verwrity.analysis.manuscript import manuscript_task, prepare_manuscript_task
from verwrity.analysis.wiki_instruction import prepare_instruction
from verwrity.analysis.wiki import (
    prepare_wiki, parse_wiki_json, populate_wiki, page_hash, manuscript_hash,
    WikiReviewReport, repair_wiki_prompt,
)
from verwrity.ai.tts import TTSConfigurationError
from verwrity.ai.stt import AudioInput, AUDIO_TYPES, MAX_AUDIO_BYTES, STTConfigurationError, STTRequestError, download_whisper_model
from verwrity.web.services.workspace import active_store
from verwrity.project.files import PROJECT_LOCK


ai_blueprint = Blueprint("ai", __name__)

_OPERATIONS = {
    "ai.transcribe_audio": "STT", "ai.read_scene_aloud": "TTS",
    "ai.read_llm_answer_aloud": "TTS answer", "ai.ask_project": "LLM",
    "ai.ask_project_stream": "LLM stream", "ai.download_stt_model": "Whisper download",
    "ai.download_kokoro_models": "Kokoro download",
    "ai.populate_wiki_page": "Wiki LLM",
}


@ai_blueprint.before_request
def _begin_operation():
    operation = _OPERATIONS.get(request.endpoint)
    if operation:
        g.ai_operation, g.ai_request_id = operation, uuid4().hex[:8]
        g.ai_started, g.ai_stage = perf_counter(), "validation"
        current_app.logger.info("%s [%s] started", operation, g.ai_request_id)


def _ai_stage(stage: str):
    g.ai_stage = stage
    current_app.logger.info("%s [%s]: %s", g.ai_operation, g.ai_request_id, stage)


def _log_provider_failure(error):
    """Report transport categories without raw exception bodies or credentials."""
    cause = error.__cause__
    current_app.logger.warning("%s [%s] provider failure (%s)", g.ai_operation, g.ai_request_id, type(error).__name__)
    if isinstance(cause, HTTPError):
        current_app.logger.warning("%s [%s] upstream HTTP %s", g.ai_operation, g.ai_request_id, cause.code)
    elif cause is not None:
        current_app.logger.warning("%s [%s] underlying failure (%s)", g.ai_operation, g.ai_request_id, type(cause).__name__)


@ai_blueprint.after_request
def _finish_operation(response):
    if hasattr(g, "ai_operation"):
        if response.is_streamed and response.mimetype == "text/event-stream":
            _ai_stage("response stream opened")
        else:
            log = current_app.logger.info if response.status_code < 400 else current_app.logger.warning
            log("%s [%s] %s in %.2fs (HTTP %s; stage=%s)", g.ai_operation, g.ai_request_id,
                "completed" if response.status_code < 400 else "failed", perf_counter() - g.ai_started,
                response.status_code, g.ai_stage)
    return response


@ai_blueprint.teardown_request
def _unexpected_operation_error(error):
    if error is not None and hasattr(g, "ai_operation"):
        current_app.logger.error("%s [%s] failed during %s (%s)", g.ai_operation, g.ai_request_id, g.ai_stage, type(error).__name__)


def _settings():
    return current_app.extensions["ai_settings"]


def _user_id() -> str:
    return current_app.config["USER_ID"]


@ai_blueprint.post("/ai/wiki/<uuid:page_id>")
def populate_wiki_page(page_id):
    data = request.get_json(silent=True)
    if not isinstance(data, dict) or data.get("action") not in {"suggest", "populate", "instruct"}:
        return jsonify(error="Choose a wiki AI action."), 400
    purpose = data.get("purpose", "")
    if not isinstance(purpose, str) or len(purpose) > 2000 or (data["action"] == "populate" and not purpose.strip()):
        return jsonify(error="Describe the page's subject and purpose (up to 2,000 characters)."), 400
    settings = _settings().load(_user_id())["llm"]
    if not _is_loopback(settings["endpoint"]) and settings["remote_consent_endpoint"] != settings["endpoint"]:
        return jsonify(error="Acknowledge this exact LLM endpoint's data disclosure in AI Models first."), 403
    with PROJECT_LOCK:
        store = active_store()
        store.ensure_current()
        project = deepcopy(store.get())
    page = next((p for p in project.wiki_pages if p.id == page_id), None)
    if page is None:
        return jsonify(error="Wiki page not found."), 404
    if data.get("page_hash") != page_hash(page):
        return jsonify(error="This wiki page changed. Reopen it before reviewing."), 409
    try:
        instruction = data["action"] == "instruct"
        if instruction:
            purpose = page.purpose
            context, prompt = prepare_instruction(project, page, data.get("instruction"),
                data.get("scope", "page"), data.get("before_percent", 0), data.get("after_percent", 0),
                session.get("active_scene_id"))
        else:
            context, prompt = prepare_wiki(project, page, purpose.strip(), data["action"] == "suggest")
        client = current_app.extensions["llm_registry"].get(settings["standard"])
        _ai_stage("reading current manuscript and requesting wiki review")
        raw = client.complete(settings["endpoint"], settings["model"], settings["token"], prompt)
        parsed = parse_wiki_json(raw)
        _ai_stage("checking source evidence and wiki ownership")
        if data["action"] == "suggest":
            suggested = parsed.get("purpose")
            if not isinstance(suggested, str) or not suggested.strip() or len(suggested) > 2000:
                raise LLMRequestError("The model did not suggest a valid page purpose.")
            result = {"purpose": suggested.strip()}
        else:
            report = WikiReviewReport()
            updated, summary, discarded = populate_wiki(project, page, purpose if instruction else purpose.strip(),
                parsed, context, settings, report, instruction=instruction)
            correction_attempted = False
            if report.rejected and not report.applied and not instruction:
                correction_attempted = True
                _ai_stage("requesting one corrected wiki response")
                try:
                    corrected_raw = client.complete(settings["endpoint"], settings["model"], settings["token"],
                        repair_wiki_prompt(prompt, parsed, report))
                    corrected = parse_wiki_json(corrected_raw)
                    corrected_report = WikiReviewReport()
                    candidate = populate_wiki(project, page, purpose.strip(), corrected, context, settings, corrected_report)
                    if corrected_report.applied:
                        updated, summary, discarded = candidate
                        report = corrected_report
                except (LLMRequestError, LLMConfigurationError):
                    # Keep the original validated outcome; never save rejected text.
                    pass
                if not report.applied:
                    summary += " The automatic correction did not produce any applicable changes."
            # A signed proposal is committed only by the browser that still wants it.
            # Cancelled model calls can finish without ever changing project data.
            payload = {"project_id": str(project.project_id), "page_id": str(page.id),
                "page_hash": page_hash(page), "source_hash": manuscript_hash(project),
                "session_id": session["project_session_id"], "body": updated.body, **updated.provenance_dict()}
            token = URLSafeTimedSerializer(current_app.secret_key, salt="wiki-ai-v1").dumps(payload)
            result = {"proposal": token, "summary": summary, "discarded": discarded,
                "correction_attempted": correction_attempted,
                "applied": report.applied,
                "omitted_citations": report.omitted_citations,
                "rejections": [{"group": r.group, "index": r.index, "reason": r.reason} for r in report.rejected]}
    except (LLMConfigurationError, ValueError) as error:
        return jsonify(error=str(error)), 400
    except LLMRequestError as error:
        _log_provider_failure(error)
        return jsonify(error=str(error)), 502
    except Exception as error:
        current_app.logger.error("Wiki LLM failed (%s)", type(error).__name__)
        return jsonify(error="The LLM could not review this wiki page."), 502
    response = jsonify(result)
    response.headers["Cache-Control"] = "no-store"
    return response


@ai_blueprint.get("/ai/models")
def ai_models():
    registry = current_app.extensions["tts_registry"]
    return jsonify({
        "capabilities": {
            "text_to_speech": {"providers": registry.choices()},
            "speech_to_text": {"providers": current_app.extensions["stt_registry"].choices(), "available": True, "audio_upload": "raw-v1"},
            "llm": {"providers": current_app.extensions["llm_registry"].choices(), "available": True},
        },
        "settings": _settings().public(_user_id()),
    })


@ai_blueprint.post("/ai/models/stt")
def update_stt_settings():
    try:
        value = _settings().update_stt(_user_id(), request.get_json(silent=True), current_app.extensions["stt_registry"])
    except ValueError as error:
        return jsonify({"error": str(error)}), 400
    return jsonify(value)


@ai_blueprint.post("/ai/models/stt/download")
def download_stt_model():
    data = request.get_json(silent=True)
    if not isinstance(data, dict) or data.get("accept_download") is not True or not isinstance(data.get("model"), str):
        return jsonify({"error": "Explicitly accept the Whisper model download first."}), 400
    settings = _settings()
    if settings.load(_user_id())["stt"]["provider"] != "faster_whisper":
        return jsonify({"error": "Select and save Faster Whisper before downloading a local model."}), 400
    try:
        root = settings.stt_model_root(_user_id())
        _ai_stage("downloading model files")
        path = download_whisper_model(data["model"], root)
        _ai_stage("saving installed model configuration")
        value = settings.update_stt(_user_id(), {"model_path": path}, current_app.extensions["stt_registry"])
    except ValueError as error:
        return jsonify({"error": str(error)}), 400
    except STTRequestError as error:
        return jsonify({"error": str(error)}), 502
    return jsonify(value)


@ai_blueprint.post("/ai/transcribe")
def transcribe_audio():
    configured = _settings().load(_user_id())["stt"]
    expected = request.headers.get("X-Verwrity-STT-Configuration")
    if expected is not None and expected != configuration_hash(configured):
        return jsonify(error="Speech settings changed. Reopen Dictate draft before retrying pending audio."), 409
    try:
        _ai_stage("checking provider configuration and audio consent")
        provider = current_app.extensions["stt_registry"].get(configured["provider"])
        provider.validate(configured)
        if provider.is_remote(configured) and configured["remote_consent_endpoint"] != configured["endpoint"]:
            return jsonify({"error": "Online audio transcription requires consent for this exact endpoint in AI Models."}), 403
        if request.mimetype not in AUDIO_TYPES:
            return jsonify({"error": "Record audio in WebM, Ogg, MP4, WAV, or MP3 format."}), 400
        # Raw audio avoids multipart upload handlers spooling recordings to disk.
        _ai_stage("receiving recorded audio")
        data = request.stream.read(MAX_AUDIO_BYTES + 1)
        if not data or len(data) > MAX_AUDIO_BYTES:
            return jsonify({"error": "Record non-empty audio smaller than 24 MiB."}), 400
        current_app.logger.info("STT [%s] received %d audio bytes (%s)", g.ai_request_id, len(data), request.mimetype)
        _ai_stage("transcribing audio")
        text = provider.transcribe(AudioInput(data, request.mimetype), configured)
        if not isinstance(text, str) or len(text) > 100000:
            raise STTRequestError("The provider returned an invalid or oversized transcript.")
    except STTConfigurationError as error:
        current_app.logger.warning("STT [%s] configuration: %s", g.ai_request_id, str(error))
        return jsonify({"error": str(error)}), 400
    except STTRequestError as error:
        current_app.logger.warning("STT [%s]: %s", g.ai_request_id, str(error))
        return jsonify({"error": str(error)}), 502
    except RequestEntityTooLarge:
        raise
    except Exception as error:
        # Provider errors may include private audio paths or authentication;
        # keep their details out of browser responses and application logs.
        current_app.logger.error("STT [%s] unexpected provider failure (%s)", g.ai_request_id, type(error).__name__)
        return jsonify({"error": "The selected provider could not transcribe the recording."}), 502
    _ai_stage("returning transcript")
    response = jsonify({"text": text.strip()})
    response.headers["Cache-Control"] = "no-store"
    return response


@ai_blueprint.post("/ai/models/tts")
def update_tts_settings():
    try:
        value = _settings().update_tts(
            _user_id(), request.get_json(silent=True), current_app.extensions["tts_registry"]
        )
    except ValueError as error:
        return jsonify({"error": str(error)}), 400
    return jsonify(value)


@ai_blueprint.post("/ai/read-answer")
def read_llm_answer_aloud():
    data = request.get_json(silent=True)
    text = data.get("text") if isinstance(data, dict) else None
    if not isinstance(text, str) or not text.strip() or len(text) > 12000:
        return jsonify({"error": "Choose a completed answer up to 12,000 characters."}), 400
    configured = _settings().load(_user_id())["tts"]
    try:
        provider = current_app.extensions["tts_registry"].get(configured["provider"])
        if provider.is_remote and not configured["remote_consent"]:
            return jsonify({"error": "Remote text-to-speech is not enabled. Acknowledge the provider's data disclosure in AI Models first."}), 403
        options, configuration = provider.prepare(configured)
        _ai_stage("synthesizing answer audio")
        audio = provider.synthesize(text.strip(), options, configuration)
    except TTSConfigurationError as error:
        _log_provider_failure(error)
        return jsonify({"error": str(error)}), 400
    except RuntimeError as error:
        _log_provider_failure(error)
        return jsonify({"error": str(error)}), 502
    except Exception as error:
        current_app.logger.error("TTS answer failed (%s)", type(error).__name__)
        return jsonify({"error": "The selected text-to-speech provider could not read the answer."}), 502
    media_type = getattr(provider, "media_type", "audio/wav")
    extension = "mp3" if media_type == "audio/mpeg" else "wav"
    return send_file(BytesIO(audio), mimetype=media_type, download_name=f"answer.{extension}", as_attachment=False, max_age=0)


@ai_blueprint.post("/ai/models/llm")
def update_llm_settings():
    try:
        value = _settings().update_llm(
            _user_id(), request.get_json(silent=True), current_app.extensions["llm_registry"]
        )
    except ValueError as error:
        return jsonify({"error": str(error)}), 400
    return jsonify(value)


@ai_blueprint.post("/ai/ask")
def ask_project():
    prepared, error = _prepare_answer_request(request.get_json(silent=True))
    if error:
        message, status_code = error
        return jsonify({"error": message}), status_code
    settings, project, context, prompt, client = prepared
    try:
        _ai_stage("selecting project context and requesting answer")
        raw = client.complete(str(settings["endpoint"]), str(settings["model"]), str(settings["token"]), prompt)
        parsed = parse_answer(raw)
        result = {"answer": parsed["answer"], "evidence": validate_evidence(project, parsed, context)}
    except LLMConfigurationError as error:
        _log_provider_failure(error)
        return jsonify({"error": str(error)}), 400
    except LLMRequestError as error:
        _log_provider_failure(error)
        return jsonify({"error": str(error)}), 502
    except Exception as error:
        current_app.logger.error("LLM failed (%s)", type(error).__name__)
        return jsonify({"error": "The selected LLM provider failed to answer this question."}), 502
    return jsonify(result)


def _prepare_answer_request(data):
    """Validate common question fields before headers are committed."""
    if not isinstance(data, dict):
        return None, ("Enter a question about the project.", 400)
    task = None
    if "task_id" in data:
        if not isinstance(data["task_id"], str):
            return None, ("Choose a valid manuscript task.", 400)
        try:
            task = manuscript_task(data["task_id"])
        except ValueError:
            return None, ("Choose a valid manuscript task.", 400)
        # A task's scope and prompt are server-owned; unrelated conversation is excluded.
        data = {"question": task.prompt, "before_percent": 100, "after_percent": 100,
                "include_wiki": False, "history": []}
    request_kind = data.get("request_kind", "question")
    if not isinstance(request_kind, str) or request_kind not in {"question", "alternatives"}:
        return None, ("Choose a valid question action.", 400)
    alternatives = request_kind == "alternatives"
    question = "Suggest alternatives" if alternatives else data.get("question")
    before, after = data.get("before_percent", 100), data.get("after_percent", 100)
    include_wiki, history = data.get("include_wiki", True), data.get("history", [])
    context_mode = data.get("context_mode", "project")
    if (not isinstance(context_mode, str) or context_mode not in {"project", "selection"}
            or (context_mode == "selection" and not isinstance(data.get("selected_context"), dict))
            or (alternatives and context_mode != "selection")):
        return None, ("Choose project context or select a current manuscript passage.", 400)
    if not isinstance(question, str) or not question.strip() or len(question) > 4000:
        return None, ("Enter a question up to 4,000 characters.", 400)
    if any(isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= 100
           for value in (before, after)) or not isinstance(include_wiki, bool):
        return None, ("Choose valid manuscript ranges and wiki settings.", 400)
    if (not isinstance(history, list) or len(history) > 8
            or any(not isinstance(turn, dict) or not isinstance(turn.get("question"), str)
                   or not isinstance(turn.get("answer"), str)
                   or len(turn["question"]) > 4000 or len(turn["answer"]) > 12000 for turn in history)):
        return None, ("The conversation history is invalid. Start a new question.", 400)
    settings = _settings().load(_user_id())["llm"]
    if not _is_loopback(settings["endpoint"]) and settings["remote_consent_endpoint"] != settings["endpoint"]:
        return None, ("Remote project questions are disabled until you acknowledge the data disclosure in AI Models.", 403)
    with PROJECT_LOCK:
        project = deepcopy(active_store().get())
    if not project.current_scenes():
        return None, ("Add a manuscript scene before asking a project question.", 400)
    if task:
        if not any(scene.text.strip() for scene in project.current_scenes()):
            return None, ("Add manuscript text before running this review.", 400)
        context, prompt = prepare_manuscript_task(project, task)
    else:
        try:
            if alternatives:
                context, prompt = prepare_alternatives(project, session.get("active_scene_id"), data["selected_context"])
            else:
                context, prompt = prepare_question(project, session.get("active_scene_id"), question.strip(), before, after,
                                                   include_wiki, history,
                                                   selection=data["selected_context"] if context_mode == "selection" else None)
        except ValueError as error:
            return None, (str(error), 400)
    client = current_app.extensions["llm_registry"].get(settings["standard"])
    return (settings, project, context, prompt, client), None


def _partial_answer(raw: str) -> str:
    """Decode the complete prefix of the JSON answer string as it arrives."""
    match = re.search(r'"answer"\s*:\s*"', raw)
    if not match:
        return ""
    index, output = match.end(), []
    while index < len(raw):
        char = raw[index]
        if char == '"':
            break
        if char != "\\":
            output.append(char)
            index += 1
            continue
        if index + 1 >= len(raw):
            break
        escaped = raw[index + 1]
        simple = {'"': '"', "\\": "\\", "/": "/", "b": "\b", "f": "\f", "n": "\n", "r": "\r", "t": "\t"}
        if escaped in simple:
            output.append(simple[escaped])
            index += 2
        elif escaped == "u" and index + 6 <= len(raw):
            try:
                codepoint = int(raw[index + 2:index + 6], 16)
            except ValueError:
                break
            if 0xD800 <= codepoint <= 0xDBFF and index + 12 <= len(raw) and raw[index + 6:index + 8] == "\\u":
                try:
                    low = int(raw[index + 8:index + 12], 16)
                except ValueError:
                    break
                if 0xDC00 <= low <= 0xDFFF:
                    codepoint = 0x10000 + ((codepoint - 0xD800) << 10) + low - 0xDC00
                    index += 12
                else:
                    index += 6
            else:
                index += 6
            output.append(chr(codepoint))
        else:
            break
    return "".join(output)


@ai_blueprint.post("/ai/ask/stream")
def ask_project_stream():
    _ai_stage("selecting project context")
    prepared, error = _prepare_answer_request(request.get_json(silent=True))
    if error:
        message, status_code = error
        return jsonify({"error": message}), status_code
    settings, project, context, prompt, client = prepared

    @stream_with_context
    def events():
        raw, sent_answer = "", ""
        outcome = "completed"
        try:
            context_characters = len(str(context["text"]))
            yield "data: " + json.dumps({
                "type": "status",
                "context_characters": context_characters,
                "estimated_context_tokens": (context_characters + 3) // 4,
                "scene_count": len(context["scene_ids"]),
                "wiki_count": len(context["wiki_ids"]),
            }) + "\n\n"
            _ai_stage("requesting answer; waiting for model output")
            for delta in client.stream(str(settings["endpoint"]), str(settings["model"]),
                                       str(settings["token"]), prompt):
                if not raw:
                    _ai_stage("receiving model output")
                raw += delta
                if len(raw) > 2 * 1024 * 1024:
                    raise LLMRequestError("The model response was too large to display.")
                partial = _partial_answer(raw)
                if partial.startswith(sent_answer) and len(partial) > len(sent_answer):
                    addition = partial[len(sent_answer):]
                    sent_answer = partial
                    yield "data: " + json.dumps({"type": "delta", "text": addition}, ensure_ascii=False) + "\n\n"
            _ai_stage("checking answer format and source evidence")
            parsed = parse_answer(raw)
            result = {"answer": parsed["answer"], "evidence": validate_evidence(project, parsed, context)}
            yield "data: " + json.dumps({"type": "result", "result": result}, ensure_ascii=False) + "\n\n"
        except (LLMConfigurationError, LLMRequestError) as exc:
            outcome = "failed"
            _log_provider_failure(exc)
            current_app.logger.warning("LLM stream [%s]: %s", g.ai_request_id, str(exc))
            yield "data: " + json.dumps({"type": "error", "error": str(exc)}) + "\n\n"
        except GeneratorExit:
            outcome = "client disconnected"
            raise
        except Exception as error:
            outcome = "failed"
            current_app.logger.error("LLM stream [%s] failed (%s)", g.ai_request_id, type(error).__name__)
            yield "data: " + json.dumps({"type": "error", "error": "The selected LLM provider failed to answer this question."}) + "\n\n"
        finally:
            current_app.logger.info("LLM stream [%s] %s in %.2fs", g.ai_request_id, outcome, perf_counter() - g.ai_started)

    response = Response(events(), mimetype="text/event-stream")
    response.headers["Cache-Control"] = "no-cache, no-transform"
    response.headers["X-Accel-Buffering"] = "no"
    return response


@ai_blueprint.post("/ai/models/tts/kokoro-download")
def download_kokoro_models():
    user_id = _user_id()
    configured = _settings().load(user_id)["tts"]
    if configured["provider"] != "kokoro_local":
        return jsonify({"error": "Select and save Kokoro as the text-to-speech provider before downloading its files."}), 400
    installer = KokoroModelInstaller(_settings().model_root(user_id))
    try:
        _ai_stage("downloading and verifying model files")
        files = installer.install()
        _ai_stage("saving installed model configuration")
        value = _settings().update_tts(user_id, {
            "model_path": files["kokoro-v1.0.onnx"],
            "voices_path": files["voices-v1.0.bin"],
        }, current_app.extensions["tts_registry"])
    except ModelDownloadError as error:
        _log_provider_failure(error)
        return jsonify({"error": str(error)}), 502
    except ValueError as error:
        return jsonify({"error": str(error)}), 400
    return jsonify(value)


@ai_blueprint.post("/scene/<scene_id>/read-aloud")
def read_scene_aloud(scene_id: str):
    try:
        parsed_id = UUID(scene_id)
    except ValueError:
        return jsonify({"error": "Scene not found"}), 404
    project = active_store().get()
    scene = project.scene(parsed_id)
    if scene is None or scene.historical or session.get("active_scene_id") != str(scene.id):
        return jsonify({"error": "The requested scene is not currently loaded"}), 404
    text = scene.text
    if not text.strip():
        return jsonify({"error": "This scene has no text to read"}), 400

    configured = _settings().load(_user_id())["tts"]
    try:
        provider = current_app.extensions["tts_registry"].get(configured["provider"])
        if provider.is_remote:
            if not configured["remote_consent"]:
                return jsonify({"error": "Remote reading is not enabled. Choose the remote provider and acknowledge its data disclosure in AI Models."}), 403
        options, configuration = provider.prepare(configured)
        _ai_stage("synthesizing scene audio")
        audio = provider.synthesize(text, options, configuration)
    except TTSConfigurationError as error:
        _log_provider_failure(error)
        return jsonify({"error": str(error)}), 400
    except RuntimeError as error:
        _log_provider_failure(error)
        return jsonify({"error": str(error)}), 502
    except Exception as error:
        current_app.logger.error("TTS failed (%s)", type(error).__name__)
        return jsonify({"error": "The selected text-to-speech provider failed to generate audio."}), 502
    media_type = getattr(provider, "media_type", "audio/wav")
    extension = "mp3" if media_type == "audio/mpeg" else "wav"
    return send_file(BytesIO(audio), mimetype=media_type, download_name=f"scene.{extension}", as_attachment=False, max_age=0)
