"""Explicit speaker review and independent novelist dialogue views."""
from copy import deepcopy
from uuid import UUID, uuid4
from flask import Blueprint, current_app, jsonify, request, session
from itsdangerous import URLSafeTimedSerializer, BadSignature
from verwrity.domain.story import WikiPage
from verwrity.domain.dialogue import DialogueAttribution, dialogue_rows
from verwrity.analysis.dialogue import (characters, fingerprint, extraction_prompt, parse_extraction,
                                     evaluation_prompt, parse_evaluation)
from verwrity.ai.llm import _is_loopback
from verwrity.project.files import PROJECT_LOCK
from verwrity.project.drafts import DraftConflict
from verwrity.web.services.workspace import active_store, scene_source_hash

dialogue_blueprint = Blueprint("dialogue", __name__)
dialogue_ai_blueprint = Blueprint("dialogue_ai", __name__)


def payload():
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        raise ValueError("Expected a dialogue request object")
    return data


@dialogue_blueprint.after_request
@dialogue_ai_blueprint.after_request
def private_response(response):
    response.headers["Cache-Control"] = "no-store"
    return response


def signer():
    return URLSafeTimedSerializer(current_app.secret_key, salt="dialogue-v1")


def scene_for(project, scene_id):
    from flask import abort
    try:
        scene = project.scene(UUID(scene_id))
    except (ValueError, TypeError):
        scene = None
    if scene is None or scene.historical:
        abort(404)
    return scene


def require_snapshot(project, scene, data, whole=False):
    if (request.headers.get("X-Verwrity-Project-Id") != str(project.project_id)
            or data.get("source_hash") != scene_source_hash(scene)
            or (whole and data.get("snapshot") != fingerprint(project))):
        raise DraftConflict("The scene or project changed. Reopen the dialogue review")


def speaker_for(project, item):
    name = item.get("new_name", "")
    if not isinstance(name, str) or len(name) > 200:
        raise ValueError("Enter a character name up to 200 characters")
    if name.strip():
        name = name.strip()
        if any(name.casefold() in {page.title.casefold(), *(alias.casefold() for alias in page.aliases)}
               for page in project.wiki_pages):
            raise ValueError("That wiki name already exists; choose the page instead")
        page = WikiPage(uuid4(), name, tags=("character",))
        project.wiki_pages.append(page)
        return page.id
    if item.get("speaker_id") is not None and not isinstance(item["speaker_id"], str):
        raise ValueError("Choose a wiki speaker identity")
    identity = UUID(item["speaker_id"]) if item.get("speaker_id") else None
    if identity is not None and not any(page.id == identity for page in project.wiki_pages):
        raise ValueError("Speaker wiki page not found")
    # Explicit author selection may identify any existing wiki page as a speaker.
    return identity


def valid_range(scene, item):
    start, end, quote = item.get("start"), item.get("end"), item.get("quote")
    if (type(start) is not int or type(end) is not int or not 0 <= start < end <= len(scene.text)
            or not isinstance(quote, str) or scene.text[start:end] != quote):
        raise ValueError("Select an exact current manuscript passage")
    return start, end, quote


@dialogue_blueprint.get("/dialogue/characters")
def dialogue_characters():
    project = active_store().get()
    return jsonify(characters=characters(project), pages=[{"id": str(page.id), "title": page.title, "tags": list(page.tags)} for page in project.wiki_pages])


@dialogue_blueprint.get("/scene/<scene_id>/dialogue")
def scene_dialogue(scene_id):
    scene = scene_for(active_store().get(), scene_id)
    return jsonify(dialogue=[item.as_dict() for item in scene.dialogue], source_hash=scene_source_hash(scene), snapshot=fingerprint(active_store().get()),
                   revisions=[item.as_dict() for item in scene.revisions])


@dialogue_blueprint.post("/scene/<scene_id>/dialogue")
def assign_dialogue(scene_id):
    store = active_store()
    project = store.get()
    scene = scene_for(project, scene_id)
    data = payload()
    require_snapshot(project, scene, data, whole=True)
    start, end, quote = valid_range(scene, data)
    if data.get("id") is not None and not isinstance(data["id"], str):
        raise ValueError("Invalid dialogue identity")
    identity = UUID(data["id"]) if data.get("id") else uuid4()
    old = next((item for item in scene.dialogue if item.id == identity), None)
    if data.get("id") and old is None:
        raise ValueError("Dialogue attribution not found")
    if any(item.id != identity and not item.detached and start < item.end and end > item.start for item in scene.dialogue):
        raise ValueError("This passage overlaps an existing assignment; edit that assignment instead")
    scene.record_revision()
    before_pages = {page.id for page in project.wiki_pages}
    speaker = speaker_for(project, data)
    record = DialogueAttribution(identity, speaker, start, end, quote, old.original_quote if old else quote)
    scene.dialogue = [record if item.id == identity else item for item in scene.dialogue] if old else [*scene.dialogue, record]
    store.commit()
    from verwrity.web.routes.wiki import page_response
    return jsonify(dialogue=[item.as_dict() for item in scene.dialogue], created_pages=[page_response(page, project) for page in project.wiki_pages if page.id not in before_pages])


@dialogue_blueprint.post("/scene/<scene_id>/dialogue/<uuid:identity>/delete")
def delete_dialogue(scene_id, identity):
    store = active_store()
    project = store.get()
    scene = scene_for(project, scene_id)
    require_snapshot(project, scene, payload(), whole=True)
    scene.record_revision()
    scene.dialogue = [item for item in scene.dialogue if item.id != identity]
    store.commit()
    return jsonify(dialogue=[item.as_dict() for item in scene.dialogue])


@dialogue_blueprint.get("/wiki/page/<uuid:speaker_id>/dialogue")
def speaker_dialogue(speaker_id):
    project = active_store().get()
    page = next((page for page in project.wiki_pages if page.id == speaker_id), None)
    if page is None:
        return jsonify(error="Wiki page not found"), 404
    return jsonify(title=page.title, rows=dialogue_rows(project, speaker_id), snapshot=fingerprint(project))


@dialogue_blueprint.post("/scene/<scene_id>/dialogue/apply")
def accept_dialogue(scene_id):
    store = active_store()
    project = store.get()
    scene = scene_for(project, scene_id)
    data = payload()
    if not isinstance(data.get("proposal"), str):
        raise ValueError("Supply a dialogue review proposal")
    try:
        proposal = signer().loads(data.get("proposal", ""), max_age=3600)
    except BadSignature:
        raise ValueError("The dialogue proposal expired; extract again") from None
    if (proposal["snapshot"] != fingerprint(project) or proposal["scene_id"] != scene_id
            or proposal["session"] != session.get("project_session_id")):
        raise DraftConflict("The dialogue sources changed. Extract again before accepting")
    require_snapshot(project, scene, data, whole=True)
    choices = data.get("choices")
    if not isinstance(choices, list) or not choices or len(choices) > len(proposal["rows"]):
        raise ValueError("Choose dialogue suggestions to accept")
    seen, created_names = set(), {}
    before_pages = {page.id for page in project.wiki_pages}
    scene.record_revision()
    for choice in choices:
        index = choice.get("index") if isinstance(choice, dict) else None
        if type(index) is not int or not 0 <= index < len(proposal["rows"]) or index in seen:
            raise ValueError("Invalid dialogue review choice")
        seen.add(index)
        row = proposal["rows"][index]
        start, end, quote = valid_range(scene, row)
        name = choice.get("new_name", "")
        if not isinstance(name, str):
            raise ValueError("Enter a character name")
        key = name.strip().casefold()
        speaker = created_names.get(key) if key in created_names else speaker_for(project, choice)
        if key:
            created_names[key] = speaker
        scene.dialogue.append(DialogueAttribution(uuid4(), speaker, start, end, quote, quote,
            origin="ai-suggested-author-confirmed", run_id=proposal["run_id"]))
    store.commit()
    from verwrity.web.routes.wiki import page_response
    return jsonify(dialogue=[item.as_dict() for item in scene.dialogue], created_pages=[page_response(page, project) for page in project.wiki_pages if page.id not in before_pages])


def model_call(prompt):
    settings = current_app.extensions["ai_settings"].load(current_app.config["USER_ID"])["llm"]
    if not _is_loopback(settings["endpoint"]) and settings["remote_consent_endpoint"] != settings["endpoint"]:
        return None, (jsonify(error="Acknowledge this exact LLM endpoint in AI Models first"), 403)
    if not settings["model"].strip():
        return None, (jsonify(error="Configure an LLM model in AI Models first"), 400)
    client = current_app.extensions["llm_registry"].get(settings["standard"])
    current_app.logger.info("Dialogue AI: requesting model (%d prompt characters)", len(prompt))
    return client.complete(settings["endpoint"], settings["model"], settings["token"], prompt), None


@dialogue_ai_blueprint.post("/scene/<scene_id>/dialogue/extract")
def extract_dialogue(scene_id):
    try:
        with PROJECT_LOCK:
            store = active_store()
            store.ensure_current()
            project = deepcopy(store.get())
            scene = scene_for(project, scene_id)
            require_snapshot(project, scene, payload())
            snapshot = fingerprint(project)
        prompt = extraction_prompt(project, scene)
    except ValueError as error:
        return jsonify(error=str(error)), 400
    try:
        raw, error = model_call(prompt)
        if error:
            return error
        result = parse_extraction(raw, project, scene)
    except Exception as error:
        current_app.logger.warning("Dialogue extraction failed (%s)", type(error).__name__)
        return jsonify(error="The model could not return valid dialogue suggestions. Try again."), 502
    current_app.logger.info("Dialogue extraction: verified %d suggestions; omitted %d", len(result["rows"]), result["discarded"])
    result["proposal"] = signer().dumps({**result, "scene_id": scene_id, "snapshot": snapshot,
                                       "session": session.get("project_session_id")})
    return jsonify(**result, source_hash=scene_source_hash(scene), snapshot=snapshot)


@dialogue_ai_blueprint.post("/wiki/page/<uuid:speaker_id>/dialogue/evaluate")
def evaluate_dialogue(speaker_id):
    try:
        with PROJECT_LOCK:
            store = active_store()
            store.ensure_current()
            project = deepcopy(store.get())
            snapshot = fingerprint(project)
            if (payload()).get("snapshot") != snapshot:
                raise DraftConflict("The collected dialogue changed. Reopen it before evaluating")
        rows, prompt = evaluation_prompt(project, speaker_id)
    except ValueError as error:
        return jsonify(error=str(error)), 400
    try:
        raw, error = model_call(prompt)
        if error:
            return error
        observations = parse_evaluation(raw, rows)
    except Exception as error:
        current_app.logger.warning("Dialogue evaluation failed (%s)", type(error).__name__)
        return jsonify(error="The model could not return a valid voice evaluation. Try again."), 502
    with PROJECT_LOCK:
        active_store().ensure_current()
        if fingerprint(active_store().get()) != snapshot:
            raise DraftConflict("The dialogue changed during evaluation. Run it again")
    current_app.logger.info("Dialogue evaluation: verified %d observations", len(observations))
    return jsonify(observations=observations, snapshot=snapshot)
