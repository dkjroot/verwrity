"""Feature-gated, author-directed map and typed wiki record edits."""

from dataclasses import replace
from uuid import uuid4
from flask import Blueprint, abort, jsonify, render_template, request

from verwrity.domain.story import WikiPage
from verwrity.domain.world import (CharacterSheet, MapLocation, ItemDefinition, WorldMap, WorldPage,
    read_record, validate_world, stamp_authorship)
from verwrity.project.drafts import DraftConflict
from verwrity.web.routes.wiki import _revision, page_response
from verwrity.web.services.workspace import active_store
from verwrity.web.services.world import form_fields, world_hash, world_state


world_blueprint = Blueprint("world", __name__)


def _enabled(project, kind=None):
    allowed = project.features.fingal_mode if kind == "item" else project.features.map_enabled if kind == "location" else project.features.characters_enabled if kind == "character" else project.features.map_enabled or project.features.characters_enabled
    if not allowed:
        abort(404)


def _mutation(project):
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        raise ValueError("Expected world authoring fields")
    if request.headers.get("X-Verwrity-Project-Id") != str(project.project_id):
        raise DraftConflict("The active project changed. Keep your edits and reopen the project.")
    if data.get("revision") != world_hash(project):
        raise DraftConflict("World data changed elsewhere. Keep your edits; reload the map or reopen the wiki sheet before saving.")
    return data


def _page(project, identity):
    page = next((p for p in project.wiki_pages if p.id == identity), None)
    if page is None:
        abort(404)
    return page


def _commit(store, page=None):
    validate_world(store.get())
    store.commit()
    response = world_state(store.get())
    if page:
        response["page"] = page_response(page, store.get())
    return jsonify(response)


@world_blueprint.get("/world/state")
def state():
    project = active_store().get()
    _enabled(project)
    response = jsonify(world_state(project))
    response.headers["Cache-Control"] = "no-store"
    return response


@world_blueprint.get("/world/fragment")
def fragment():
    project = active_store().get()
    # Disabled projects return an empty fragment, never disabled tool buttons.
    return render_template("_world_workspace.html", project=project)


@world_blueprint.post("/world/maps")
def create_map():
    store = active_store()
    project = store.get()
    _enabled(project, "location")
    data = _mutation(project)
    project.maps.append(read_record(WorldMap, {"id": str(uuid4()), "title": data.get("title")}))
    return _commit(store)


@world_blueprint.post("/world/maps/<uuid:map_id>")
def save_map(map_id):
    store = active_store()
    project = store.get()
    _enabled(project, "location")
    data = _mutation(project)
    index = next((i for i, m in enumerate(project.maps) if m.id == map_id), None)
    if index is None:
        abort(404)
    project.maps[index] = read_record(WorldMap, {"id": str(map_id), "title": data.get("title"), "initial_location": data.get("initial_location"), "fingal_id": project.maps[index].fingal_id})
    return _commit(store)


@world_blueprint.post("/world/maps/<uuid:map_id>/delete")
def delete_map(map_id):
    store = active_store()
    project = store.get()
    _enabled(project, "location")
    _mutation(project)
    if not any(m.id == map_id for m in project.maps):
        abort(404)
    if any(page.world.location and page.world.location.map_id == map_id for page in project.wiki_pages):
        raise ValueError("Move or remove this map's locations explicitly before deleting it")
    project.maps[:] = [m for m in project.maps if m.id != map_id]
    return _commit(store)


@world_blueprint.post("/world/pages")
def create_page():
    store = active_store()
    project = store.get()
    _enabled(project)
    data = _mutation(project)
    kind = data.get("kind")
    if kind not in {"character", "location", "item"}:
        raise ValueError("Choose a character, location or item page")
    _enabled(project, kind)
    title = data.get("title")
    if not isinstance(title, str) or not title.strip() or len(title) > 200:
        raise ValueError("Choose a wiki page title up to 200 characters")
    match = next((page for page in project.wiki_pages
        if title.strip().casefold() in {page.title.casefold(), *(alias.casefold() for alias in page.aliases)}), None)
    if match:
        if data.get("adopt_page_id") != str(match.id):
            return jsonify(error="This name already belongs to a wiki page.", existing_page={
                "id": str(match.id), "title": match.title, "kind": match.world.kind,
                "page_hash": page_hash_value(match), "can_adopt": match.world.kind in {"note", kind}}), 409
        if data.get("page_hash") != page_hash_value(match):
            raise DraftConflict("The existing wiki page changed. Retry to review its current version.")
        if match.world.kind not in {"note", kind}:
            raise ValueError("This wiki page already has a different world record type")
        if match.world.kind == kind:
            # Opening an existing record must not move it or replace its authored fields.
            return jsonify({**world_state(project), "page": page_response(match, project)})
    elif data.get("adopt_page_id"):
        raise DraftConflict("The existing wiki page changed. Retry with its current name.")
    world = read_record(WorldPage, {"kind": kind, kind: data.get("record")})
    if match:
        page = replace(match, world=world, revisions=(match.revisions + (_revision(match),))[-100:])
        project.wiki_pages[project.wiki_pages.index(match)] = page
    else:
        page = WikiPage(uuid4(), title.strip(), world=world)
        project.wiki_pages.append(page)
    return _commit(store, page)


@world_blueprint.get("/world/pages/<uuid:page_id>/editor/<kind>")
def record_editor(page_id, kind):
    project = active_store().get()
    if kind not in {"character", "location", "item"}:
        abort(404)
    _enabled(project, kind)
    page = _page(project, page_id)
    if page.world.kind not in {"note", kind}:
        return jsonify(error="This page already has a different world record type"), 409
    record = getattr(page.world, kind) or {"character": CharacterSheet, "location": MapLocation, "item": ItemDefinition}[kind]()
    response = render_template("_world_record_form.html", page=page, kind=kind,
        world_revision=world_hash(project), page_hash_value=page_hash_value(page),
        record_fields=form_fields(record, project), project=project)
    return response, {"Cache-Control": "no-store"}


def page_hash_value(page):
    from verwrity.analysis.wiki import page_hash
    return page_hash(page)


@world_blueprint.post("/world/pages/<uuid:page_id>")
def save_record(page_id):
    store = active_store()
    project = store.get()
    _enabled(project)
    data = _mutation(project)
    page = _page(project, page_id)
    kind = data.get("kind")
    if kind not in {"character", "location", "item"} or page.world.kind not in {"note", kind}:
        raise ValueError("This page already has a different world record type")
    _enabled(project, kind)
    if data.get("page_hash") != page_hash_value(page):
        raise DraftConflict("This wiki page changed. Keep your edits and reopen its sheet.")
    world = read_record(WorldPage, {"kind": kind, kind: data.get("record")})
    if page.world.source:
        world = stamp_authorship(replace(world, provenance="imported", source=page.world.source), page.title)
    updated = replace(page, world=world)
    if updated != page:
        updated = replace(updated, revisions=(page.revisions + (_revision(page),))[-100:])
        project.wiki_pages[project.wiki_pages.index(page)] = updated
        return _commit(store, updated)
    return jsonify({**world_state(project), "page": page_response(page, project)})


@world_blueprint.post("/world/pages/<uuid:page_id>/detach")
def detach_record(page_id):
    store = active_store()
    project = store.get()
    page = _page(project, page_id)
    _enabled(project, page.world.kind)
    data = _mutation(project)
    if page.world.kind == "note" or data.get("page_hash") != page_hash_value(page):
        raise DraftConflict("Reopen the wiki page before removing its structured record.")
    updated = replace(page, world=WorldPage(), revisions=(page.revisions + (_revision(page),))[-100:])
    project.wiki_pages[project.wiki_pages.index(page)] = updated
    return _commit(store, updated)
