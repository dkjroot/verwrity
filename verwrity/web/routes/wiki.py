"""Author-directed wiki edits and guarded application of AI proposals."""

import re
import json
from dataclasses import replace
from datetime import datetime, timezone
from uuid import UUID, uuid4

from flask import Blueprint, abort, redirect, request, session, url_for, jsonify, current_app
from itsdangerous import URLSafeTimedSerializer, BadSignature

from verwrity.domain.story import WikiPage, WikiRevision
from verwrity.domain.world import record_data, validate_world
from verwrity.domain.wiki_provenance import human_edit_annotations, read_annotations
from verwrity.analysis.wiki import page_hash, manuscript_hash
from verwrity.analysis.wiki_instruction import accept_replacement
from verwrity.web.services.workspace import active_store


wiki_blueprint = Blueprint("wiki", __name__)
_LINK = re.compile(r"\[\[([^\]|]+)(?:\|([^\]]+))?\]\]")


def _tags(raw: str) -> tuple[str, ...]:
    """Normalize a compact comma-separated list of human-authored tags."""
    result = []
    seen = set()
    for part in raw.split(","):
        tag = " ".join(part.split())[:40]
        key = tag.casefold()
        if tag and key not in seen:
            result.append(tag)
            seen.add(key)
        if len(result) == 20:
            break
    return tuple(result)


def _aliases(raw: str, title: str) -> tuple[str, ...]:
    """Normalize alternate page titles and omit the canonical title."""
    result = []
    seen = {title.casefold()}
    for part in raw.split(","):
        alias = " ".join(part.split())[:100]
        key = alias.casefold()
        if alias and key not in seen:
            result.append(alias)
            seen.add(key)
        if len(result) == 20:
            break
    return tuple(result)


def _page_name_taken(project, name: str, page_id: UUID | None = None) -> bool:
    key = name.casefold()
    return any(
        page.id != page_id and (page.title.casefold() == key or any(alias.casefold() == key for alias in page.aliases))
        for page in project.wiki_pages
    )


def _revision(page: WikiPage) -> WikiRevision:
    return WikiRevision(uuid4(), page.title, page.body, page.tags, datetime.now(timezone.utc).isoformat(timespec="seconds"), page.aliases, page.purpose, page.annotations, page.world)


def page_response(page, project, source_hash=None):
    source_hash = source_hash or manuscript_hash(project)
    return {"id": str(page.id), "title": page.title, "body": page.body,
            "tags": list(page.tags), "aliases": list(page.aliases), "page_hash": page_hash(page),
            **page.provenance_dict(), "world": record_data(page.world), "source_hash": source_hash,
            "revisions": [{"id": str(r.id), "title": r.title, "body": r.body,
                "tags": list(r.tags), "aliases": list(r.aliases), "savedAt": r.saved_at, "world": record_data(r.world)} for r in page.revisions]}


@wiki_blueprint.get("/wiki/page/<uuid:page_id>/data")
def page_data(page_id):
    project = active_store().get()
    page = next((p for p in project.wiki_pages if p.id == page_id), None)
    if page is None:
        abort(404)
    response = jsonify(page_response(page, project))
    response.headers["Cache-Control"] = "no-store"
    return response


@wiki_blueprint.post("/wiki/page/<uuid:page_id>/ai/apply")
def apply_ai(page_id):
    data = request.get_json(silent=True)
    if not isinstance(data, dict) or not isinstance(data.get("proposal"), str):
        return jsonify(error="No wiki proposal supplied."), 400
    try:
        payload = URLSafeTimedSerializer(current_app.secret_key, salt="wiki-ai-v1").loads(data["proposal"], max_age=3600)
    except BadSignature:
        return jsonify(error="The wiki proposal expired or is invalid. Run the review again."), 400
    store = active_store()
    project = store.get()
    page = next((p for p in project.wiki_pages if p.id == page_id), None)
    if (page is None or payload["project_id"] != str(project.project_id)
            or payload["page_id"] != str(page_id) or payload["session_id"] != session["project_session_id"]
            or payload["page_hash"] != page_hash(page) or payload["source_hash"] != manuscript_hash(project)):
        return jsonify(error="The page, manuscript, or project changed during the review. Run it again."), 409
    updated = replace(page, body=payload["body"], purpose=payload["purpose"],
        annotations=read_annotations(payload["annotations"], payload["body"]))
    if updated != page:
        updated = replace(updated, revisions=(page.revisions + (_revision(page),))[-100:])
        project.wiki_pages[project.wiki_pages.index(page)] = updated
        store.commit()
    return jsonify(page_response(updated, project))


@wiki_blueprint.post("/wiki/page/<uuid:page_id>/suggestion/<uuid:annotation_id>/dismiss")
def dismiss_suggestion(page_id, annotation_id):
    store = active_store()
    project = store.get()
    page = next((p for p in project.wiki_pages if p.id == page_id), None)
    if page is None:
        abort(404)
    data = request.get_json(silent=True) or {}
    if data.get("page_hash") != page_hash(page):
        return jsonify(error="This page changed. Reopen it before dismissing suggestions."), 409
    updated = replace(page, annotations=tuple(replace(a, status="dismissed")
        if a.id == annotation_id and a.kind == "suggestion" else a for a in page.annotations))
    project.wiki_pages[project.wiki_pages.index(page)] = updated
    store.commit()
    return jsonify(page_response(updated, project))


@wiki_blueprint.post("/wiki/page/<uuid:page_id>/suggestion/<uuid:annotation_id>/accept")
def accept_suggestion(page_id, annotation_id):
    store = active_store()
    project = store.get()
    page = next((p for p in project.wiki_pages if p.id == page_id), None)
    if page is None:
        abort(404)
    data = request.get_json(silent=True)
    if not isinstance(data, dict) or data.get("page_hash") != page_hash(page):
        return jsonify(error="This page changed. Reopen it before accepting suggestions."), 409
    updated = accept_replacement(page, annotation_id, manuscript_hash(project))
    updated = replace(updated, revisions=(page.revisions + (_revision(page),))[-100:])
    project.wiki_pages[project.wiki_pages.index(page)] = updated
    store.commit()
    return jsonify(page_response(updated, project))


def _replace_title_links(body: str, old_title: str, new_title: str) -> str:
    def replace(match: re.Match[str]) -> str:
        if match.group(1).strip().casefold() != old_title.casefold():
            return match.group(0)
        return f"[[{new_title}|{match.group(2)}]]" if match.group(2) else f"[[{new_title}]]"
    return _LINK.sub(replace, body)


def _renamed_links(page, body, old_title, new_title, history):
    annotations = []
    for a in page.annotations:
        start = len(_replace_title_links(page.body[:a.start], old_title, new_title))
        quote = _replace_title_links(a.quote, old_title, new_title)
        if body[start:start + len(quote)] == quote:
            annotations.append(replace(a, start=start, end=start + len(quote), quote=quote))
    return replace(page, body=body, revisions=history[-100:], annotations=tuple(annotations))


@wiki_blueprint.post("/wiki/page/create")
def create_page():
    """Create a blank human-authored page from selected manuscript text."""
    title = " ".join(request.form.get("title", "").split())[:200]
    store = active_store()
    project = store.get()
    if title and not _page_name_taken(project, title):
        project.wiki_pages.append(WikiPage(uuid4(), title))
        store.commit()
    elif not title:
        session["wiki_error"] = "Enter a title to create a wiki page."
    else:
        session["wiki_error"] = "A page with that title already exists; it has been opened instead."
    session["has_chosen_project"] = True
    page = next((page for page in project.wiki_pages if page.title.casefold() == title.casefold()), None)
    return redirect(url_for("workspace.index", wiki_page=page.id if page else ""))


@wiki_blueprint.post("/wiki/page/<page_id>/save")
def save_page(page_id: str):
    """Save a human-authored page while preserving its stable identity."""
    try:
        page_uuid = UUID(page_id)
    except ValueError:
        abort(404)
    title = " ".join(request.form.get("title", "").split())[:200]
    # HTML multipart forms serialize textarea line breaks as CRLF. Replay edits
    # against the editor's LF text so transport formatting cannot adopt paragraphs.
    body = request.form.get("body", "").replace("\r\n", "\n").replace("\r", "\n")[:100_000]
    tags = _tags(request.form.get("tags", "")[:2_000])
    aliases = _aliases(request.form.get("aliases", "")[:2_000], title)
    store = active_store()
    project = store.get()
    page_index = next((i for i, page in enumerate(project.wiki_pages) if page.id == page_uuid), None)
    if page_index is None:
        abort(404)
    if not title or _page_name_taken(project, title, page_uuid) or any(_page_name_taken(project, alias, page_uuid) for alias in aliases):
        if request.accept_mimetypes.best == "application/json":
            return jsonify(error="Page titles and alternate titles must be non-empty and unique."), 400
        session["wiki_error"] = "Page titles and alternate titles must be non-empty and unique."
        return redirect(url_for("workspace.index", wiki_page=page_id))
    existing = project.wiki_pages[page_index]
    if request.form.get("page_hash") and request.form["page_hash"] != page_hash(existing):
        return jsonify(error="This page changed in another tab. Keep your edits and reopen the page."), 409
    purpose = request.form.get("purpose", existing.purpose)[:2000]
    edits = None
    if "authorship_edits" in request.form:
        try:
            edits = json.loads(request.form["authorship_edits"])
        except (ValueError, RecursionError) as error:
            raise ValueError("Invalid wiki edit history. Keep your edits and retry.") from error
    annotations = human_edit_annotations(existing.body, body, existing.annotations, edits)
    changed = (existing.title, existing.body, existing.tags, existing.aliases, existing.purpose, existing.annotations) != (title, body, tags, aliases, purpose, annotations)
    revisions = existing.revisions + ((_revision(existing),) if changed else ())
    project.wiki_pages[page_index] = replace(existing, title=title, body=body, tags=tags,
        revisions=revisions[-100:], aliases=aliases, purpose=purpose,
        annotations=annotations)
    from verwrity.domain.world import stamp_authorship
    project.wiki_pages[page_index] = replace(project.wiki_pages[page_index],
        world=stamp_authorship(existing.world, title))
    if title != existing.title:
        for index, linked_page in enumerate(project.wiki_pages):
            if linked_page.id == existing.id:
                continue
            updated_body = _replace_title_links(linked_page.body, existing.title, title)
            if updated_body != linked_page.body:
                history = linked_page.revisions + (_revision(linked_page),)
                project.wiki_pages[index] = _renamed_links(linked_page, updated_body, existing.title, title, history)
    store.commit()
    session["has_chosen_project"] = True
    if request.args.get("response") == "json":
        return jsonify(page_response(project.wiki_pages[page_index], project))
    return redirect(url_for("workspace.index", wiki_page=page_id))


@wiki_blueprint.post("/wiki/page/<page_id>/restore/<revision_id>")
def restore_revision(page_id: str, revision_id: str):
    """Restore a prior page snapshot while retaining the version being replaced."""
    try:
        page_uuid, revision_uuid = UUID(page_id), UUID(revision_id)
    except ValueError:
        abort(404)
    store = active_store()
    project = store.get()
    page_index = next((i for i, page in enumerate(project.wiki_pages) if page.id == page_uuid), None)
    if page_index is None:
        abort(404)
    page = project.wiki_pages[page_index]
    revision = next((item for item in page.revisions if item.id == revision_uuid), None)
    if revision is None:
        abort(404)
    if _page_name_taken(project, revision.title, page.id) or any(_page_name_taken(project, alias, page.id) for alias in revision.aliases):
        session["wiki_error"] = "That revision cannot be restored because another page uses its title."
        return redirect(url_for("workspace.index", wiki_page=page_id))
    history = page.revisions + (_revision(page),)
    project.wiki_pages[page_index] = replace(page, title=revision.title, body=revision.body,
        tags=revision.tags, revisions=history[-100:], aliases=revision.aliases,
        purpose=revision.purpose, annotations=revision.annotations, world=revision.world)
    if page.title != revision.title:
        for index, linked_page in enumerate(project.wiki_pages):
            if linked_page.id == page.id:
                continue
            updated_body = _replace_title_links(linked_page.body, page.title, revision.title)
            if updated_body != linked_page.body:
                revisions = linked_page.revisions + (_revision(linked_page),)
                project.wiki_pages[index] = _renamed_links(linked_page, updated_body, page.title, revision.title, revisions)
    validate_world(project)
    store.commit()
    return redirect(url_for("workspace.index", wiki_page=page_id))


@wiki_blueprint.post("/wiki/page/<page_id>/delete")
def delete_page(page_id: str):
    """Delete a human-authored page; inbound links remain readable text."""
    try:
        page_uuid = UUID(page_id)
    except ValueError:
        abort(404)
    store = active_store()
    project = store.get()
    if any(item.speaker_id == page_uuid for scene in project.scenes for records in [scene.dialogue, *(revision.dialogue for revision in scene.revisions)] for item in records):
        raise ValueError("This wiki page is linked to dialogue or dialogue history. Preserve it to keep speaker identities recoverable.")
    before = len(project.wiki_pages)
    project.wiki_pages[:] = [page for page in project.wiki_pages if page.id != page_uuid]
    if before == len(project.wiki_pages):
        abort(404)
    validate_world(project)
    store.commit()
    return redirect(url_for("workspace.index"))
