"""Manuscript analysis routes."""

from uuid import UUID
from copy import deepcopy
import re

from flask import Blueprint, current_app, jsonify, request, render_template

from verwrity.ai.llm import LLMConfigurationError, LLMRequestError, _is_loopback
from verwrity.ai.scene_context import scene_author_context
from verwrity.analysis.text import MAX_SCENE_CHARACTERS, analyze_scene

from verwrity.web.services.workspace import active_store
from verwrity.project.files import PROJECT_LOCK


analysis_blueprint = Blueprint("analysis", __name__)


@analysis_blueprint.post("/thesaurus")
def thesaurus_lookup():
    payload = request.get_json(silent=True)
    word = payload.get("word") if isinstance(payload, dict) else None
    try:
        # A POST keeps the author's lookup out of URLs and ordinary access logs.
        return jsonify(current_app.extensions["thesaurus"].lookup(word))
    except ValueError as error:
        return jsonify({"error": str(error)}), 400
    except OSError:
        return jsonify({"error": "The local thesaurus file could not be read."}), 503


def _text_definitions():
    return current_app.extensions["text_analyses"], current_app.config["USER_ID"]


@analysis_blueprint.get("/text-analyses")
def text_analyses():
    settings, user = _text_definitions()
    definitions = settings.load(user)
    return jsonify({"definitions": [item.as_dict() for item in definitions],
                    "html": render_template("_text_analyses.html", text_analyses=definitions)})


@analysis_blueprint.post("/text-analyses")
@analysis_blueprint.patch("/text-analyses/<identity>")
def update_text_analysis(identity=None):
    settings, user = _text_definitions()
    try:
        definition = settings.update(user, request.get_json(silent=True), identity)
    except ValueError as error:
        return jsonify({"error": str(error)}), 400
    return jsonify(definition.as_dict())


@analysis_blueprint.delete("/text-analyses/<identity>")
def delete_text_analysis(identity):
    settings, user = _text_definitions()
    try:
        settings.delete(user, identity)
    except ValueError as error:
        return jsonify({"error": str(error)}), 400
    return jsonify({"deleted": identity})


@analysis_blueprint.post("/scene/<scene_id>/text-analysis/<identity>")
def text_analysis_scene(scene_id: str, identity: str):
    try:
        with PROJECT_LOCK:
            scene = deepcopy(active_store().get().scene(UUID(scene_id)))
    except ValueError:
        scene = None
    if scene is None or scene.historical:
        return jsonify({"error": "Scene not found"}), 404
    settings, user = _text_definitions()
    definition = next((item for item in settings.load(user) if item.id == identity), None)
    if definition is None:
        return jsonify({"error": "Analysis not found"}), 404
    data = request.get_json(silent=True)
    text = data.get("scene_text") if isinstance(data, dict) else None
    if not isinstance(text, str) or not text.strip() or len(text) > MAX_SCENE_CHARACTERS:
        return jsonify({"error": "Submit a non-empty scene up to 200,000 characters."}), 400
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    configuration = current_app.extensions["ai_settings"].load(user)["llm"]
    if not _is_loopback(configuration["endpoint"]) and configuration["remote_consent_endpoint"] != configuration["endpoint"]:
        return jsonify({"error": "Acknowledge remote scene-text disclosure in AI Models before running analysis."}), 403
    if not configuration["model"].strip():
        return jsonify({"error": "Configure an LLM model in AI Models before running analysis."}), 400
    try:
        client = current_app.extensions["llm_registry"].get(configuration["standard"])
        current_app.logger.info("Text analysis: requesting scene review (%d characters)", len(text))
        result = analyze_scene(client, configuration, definition, scene.id, text, scene_author_context(scene))
    except (LLMConfigurationError, LLMRequestError) as error:
        current_app.logger.warning("Text analysis failed (%s)", type(error).__name__)
        # A replacement provider may include source data in its exception. Keep
        # even errors from plugins out of browser responses and operational logs.
        return jsonify({"error": "The model could not complete a valid scene analysis. Check AI Models and try again."}), 502
    except Exception as error:
        current_app.logger.error("Text analysis failed (%s)", type(error).__name__)
        return jsonify({"error": "The scene analysis provider failed. Try again."}), 502
    current_app.logger.info("Text analysis: verified %d findings; discarded %d", len(result.annotations), result.discarded_findings)
    return jsonify(result.as_dict())


@analysis_blueprint.post("/scene/<scene_id>/spell-check")
def spell_check_scene(scene_id: str):
    project = active_store().get()
    try:
        scene = project.scene(UUID(scene_id))
    except ValueError:
        scene = None
    if scene is None or scene.historical:
        return jsonify({"error": "Scene not found"}), 404
    # FormData encodes LF line endings as CRLF. Keep offsets in the editor's
    # LF-based source text so decorations land on the characters analyzed.
    scene_text = request.form.get("scene_text", "").replace("\r\n", "\n").replace("\r", "\n")
    words = set(current_app.extensions["user_preferences"].spelling_dictionary(current_app.config["USER_ID"]))
    words.update(project.spelling_dictionary)
    from verwrity.domain.project_words import spelling_terms
    words.update(spelling_terms(project))
    current_app.logger.info("Spelling: analyzing %d characters", len(scene_text))
    result = current_app.extensions["spell_checker"].analyze(scene.id, scene_text, words)
    current_app.logger.info("Spelling: analysis finished (%d findings)", len(result.annotations))
    return jsonify(result.as_dict())


DICTIONARY_WORD = re.compile(r"[^\W\d_]+(?:['’\-][^\W\d_]+)*", re.UNICODE)


@analysis_blueprint.get("/spelling-dictionary/<scope>")
def get_spelling_dictionary(scope: str):
    if scope not in {"global", "project"}:
        return jsonify({"error": "Unknown dictionary scope"}), 404
    if scope == "global":
        words = current_app.extensions["user_preferences"].spelling_dictionary(current_app.config["USER_ID"])
    else:
        words = sorted(active_store().get().spelling_dictionary, key=str.casefold)
    return jsonify({"scope": scope, "words": words})


@analysis_blueprint.post("/spelling-dictionary/<scope>")
def update_spelling_dictionary(scope: str):
    if scope not in {"global", "project"}:
        return jsonify({"error": "Unknown dictionary scope"}), 404
    payload = request.get_json(silent=True) or {}
    if scope == "global" and isinstance(payload, dict) and "words" in payload:
        from verwrity.domain.project_words import checked_project_words
        preferences = current_app.extensions["user_preferences"]
        user = current_app.config["USER_ID"]
        if payload.get("previous") != preferences.spelling_dictionary(user):
            return jsonify(error="User words changed. Reopen Word lists."), 409
        try:
            values = checked_project_words(payload["words"])
            if any(len(value) > 80 or not DICTIONARY_WORD.fullmatch(value) for value in values):
                raise ValueError("User words must be single words with letters, apostrophes or hyphens.")
        except ValueError as error:
            return jsonify(error=str(error)), 400
        words = preferences.replace_spelling_dictionary(user, [value.replace("’", "'") for value in values])
        return jsonify(scope=scope, words=words)
    word = payload.get("word")
    remove = payload.get("remove", False)
    if (not isinstance(word, str) or len(word) > 80 or not DICTIONARY_WORD.fullmatch(word.strip())
            or not isinstance(remove, bool)):
        return jsonify({"error": "Enter one word using letters, apostrophes, or hyphens"}), 400
    normalized = word.strip().replace("’", "'").casefold()
    if scope == "global":
        words = current_app.extensions["user_preferences"].update_spelling_dictionary(
            current_app.config["USER_ID"], normalized, remove=remove
        )
    else:
        store = active_store()
        project = store.get()
        if remove:
            project.spelling_dictionary.discard(normalized)
        else:
            project.spelling_dictionary.add(normalized)
        store.commit()
        words = sorted(project.spelling_dictionary, key=str.casefold)
    return jsonify({"scope": scope, "words": words})


@analysis_blueprint.get("/preferences/annotations")
def annotation_preferences():
    return jsonify(current_app.extensions["user_preferences"].load(current_app.config["USER_ID"]))


@analysis_blueprint.get("/preferences/manuscript")
def manuscript_preferences():
    return jsonify(current_app.extensions["user_preferences"].load(current_app.config["USER_ID"])["manuscript"])


@analysis_blueprint.post("/preferences/manuscript")
def update_manuscript_preference():
    try:
        value = current_app.extensions["user_preferences"].update(
            current_app.config["USER_ID"], "manuscript", request.get_json(silent=True) or {}
        )
    except ValueError as error:
        return jsonify({"error": str(error)}), 400
    return jsonify(value)


@analysis_blueprint.post("/preferences/annotations/<feature>")
def update_annotation_preference(feature: str):
    try:
        value = current_app.extensions["user_preferences"].update(
            current_app.config["USER_ID"], feature, request.get_json(silent=True) or {}
        )
    except ValueError as error:
        return jsonify({"error": str(error)}), 400
    return jsonify({"feature": feature, **value})
