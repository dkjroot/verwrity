"""Explicit local word discovery; no model calls or canonical writes."""
from copy import deepcopy
from hashlib import sha256
import json
from uuid import uuid4
from flask import Blueprint, current_app, jsonify, request
from verwrity.analysis.import_vocabulary import discover
from verwrity.project.files import PROJECT_LOCK
from verwrity.web.services.workspace import active_store
from verwrity.domain.project_words import checked_project_words, known_project_words
from verwrity.domain.story import WikiPage


def state(project):
    value = {"project_id": str(project.project_id), "words": known_project_words(project), "curated": list(project.project_words),
        "dictionary": sorted(project.spelling_dictionary),
        "wiki_names": [name for page in project.wiki_pages for name in (page.title, *page.aliases)]}
    value["version"] = sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()
    return value

vocabulary_blueprint = Blueprint("import_vocabulary", __name__)


@vocabulary_blueprint.get("/project/words")
def read_words():
    return jsonify(state(active_store().get()))


@vocabulary_blueprint.post("/project/words")
def save_words():
    request.max_content_length = 2 * 1024 * 1024
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify(error="Provide project words and the current review version."), 400
    store = active_store(); project = store.get()
    if data.get("project_id") != str(project.project_id) or data.get("version") != state(project)["version"]:
        return jsonify(error="Project words or wiki names changed. Reopen Project words before saving."), 409
    project.project_words = checked_project_words(data.get("words"))
    from verwrity.analysis.spelling import normalize_word
    from verwrity.web.routes.analysis import DICTIONARY_WORD
    dictionary = checked_project_words(data.get("dictionary_words", []))
    normalized = [normalize_word(word) for word in dictionary]
    if any(len(word) > 80 or not DICTIONARY_WORD.fullmatch(word) for word in normalized):
        raise ValueError("Project dictionary entries must be single words, optionally with apostrophes or hyphens, up to 80 characters.")
    if data.get("replace_dictionary") is True:
        project.spelling_dictionary.clear()
    project.spelling_dictionary.update(normalized)
    created = []
    if data.get("create_wiki") is True:
        targets = checked_project_words(data.get("wiki_words", list(project.project_words)))
        allowed = {word.casefold() for word in known_project_words(project)}
        if any(word.casefold() not in allowed for word in targets):
            raise ValueError("Keep these project words before creating their wiki pages.")
        existing = {name.casefold() for page in project.wiki_pages for name in (page.title, *page.aliases)}
        for word in targets:
            if word.casefold() not in existing:
                page = WikiPage(uuid4(), word)
                project.wiki_pages.append(page); created.append(page)
                existing.add(word.casefold())
    store.commit()
    from verwrity.web.routes.wiki import page_response
    from verwrity.analysis.wiki import manuscript_hash
    source = manuscript_hash(project)
    return jsonify({**state(project), "created": [page_response(page, project, source) for page in created]})


@vocabulary_blueprint.post("/ai/import-vocabulary")
def scan():
    request.max_content_length = 12 * 1024 * 1024
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify(error="Provide raw import text and selected vocabulary."), 400
    try:
        with PROJECT_LOCK:
            store = active_store()
            store.ensure_current()
            project = store.get()
            if data.get("project_id") != str(project.project_id):
                return jsonify(error="Project changed. Reopen the import before scanning vocabulary."), 409
            project = deepcopy(project)
        result = discover(project, data.get("sections", []), data.get("selected", []),
            current_app.extensions["spell_checker"], current_app.extensions["user_preferences"].spelling_dictionary(current_app.config["USER_ID"]))
        return jsonify(result)
    except ValueError as error:
        return jsonify(error=str(error)), 400


@vocabulary_blueprint.after_request
def private(response):
    response.headers["Cache-Control"] = "no-store"
    return response
