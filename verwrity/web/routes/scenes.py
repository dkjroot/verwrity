"""Storyboard and scene editing routes."""

import json
import re
from dataclasses import replace
from datetime import datetime, timezone
from uuid import UUID, uuid4

from flask import Blueprint, abort, jsonify, redirect, render_template, request, session, url_for

from verwrity.domain.story import ManuscriptComment, Scene, WikiPage, WikiRevision
from verwrity.domain.dialogue import update_dialogue_ranges
from verwrity.domain.scene_metadata import SceneMetadata
from verwrity.domain.wiki_provenance import human_edit_annotations
from verwrity.web.services.workspace import active_store, sync_active_scene, update_scene_comment_ranges, scene_source_hash
from verwrity.web.routes.wiki import page_response


scene_blueprint = Blueprint("scenes", __name__)
NOTE_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")


def find_scene(scene_id: str):
    project = active_store().get()
    try:
        scene = project.scene(UUID(scene_id))
    except ValueError:
        scene = None
    return project, scene


@scene_blueprint.route("/scene/<scene_id>/metadata", methods=["GET", "POST"])
def scene_metadata(scene_id: str):
    store = active_store()
    _, scene = find_scene(scene_id)
    if scene is None or scene.historical:
        return jsonify({"error": "Scene not found"}), 404
    changed = False
    if request.method == "POST":
        data = request.get_json(silent=True)
        try:
            if isinstance(data, dict) and "metadata" in data:
                if set(data) - {"metadata", "title", "summary"}:
                    raise ValueError("Unknown scene card field")
                metadata = SceneMetadata.from_dict(data["metadata"])
                title, summary = data.get("title", scene.title), data.get("summary", scene.summary)
                if not isinstance(title, str) or not title.strip() or len(title) > 500:
                    raise ValueError("Enter a scene name up to 500 characters")
                if not isinstance(summary, str) or len(summary) > 5000:
                    raise ValueError("Enter a description up to 5,000 characters")
                title, summary = title.strip(), summary.replace("\r\n", "\n").replace("\r", "\n").strip()
            else:
                metadata = SceneMetadata.from_dict(data)
                title, summary = scene.title, scene.summary
        except ValueError as error:
            return jsonify({"error": str(error)}), 400
        changed = metadata != scene.metadata or title != scene.title or summary != scene.summary
        # Metadata edits never synchronize an editor buffer or restore prose revisions.
        if changed:
            scene.metadata = metadata
            scene.title, scene.summary = title, summary
            store.commit()
    response = jsonify({"scene_id": str(scene.id), "title": scene.title,
                        "summary": scene.summary, "metadata": scene.metadata.as_dict(), "changed": changed})
    response.headers["Cache-Control"] = "no-store"
    return response


@scene_blueprint.post("/scene/add")
def add_scene():
    store = active_store()
    project = store.get()
    sync_active_scene(project)
    project.scenes.append(Scene(
        uuid4(),
        request.form.get("scene_title", "").strip() or "Untitled scene",
        summary=request.form.get("scene_summary", "").strip(),
    ))
    session["active_scene_id"] = str(project.scenes[-1].id)
    session["has_chosen_project"] = True
    store.commit()
    return redirect(url_for("workspace.index"))


@scene_blueprint.post("/scene/select/<scene_id>")
def select_scene(scene_id: str):
    store = active_store()
    project = store.get()
    sync_active_scene(project)
    _, scene = find_scene(scene_id)
    if request.form.get("evidence_hash"):
        from verwrity.project.drafts import DraftConflict
        if scene is None or scene.historical or request.form["evidence_hash"] != scene_source_hash(scene):
            raise DraftConflict("This dialogue source changed. Reopen dialogue before navigating")
    destination = url_for("workspace.index")
    try:
        start, end = int(request.form.get("ai_start", "")), int(request.form.get("ai_end", ""))
    except ValueError:
        start, end = -1, -1
    if scene and not scene.historical and "ai_quote" in request.form:
        # Recheck evidence against the current head, including Windows line endings.
        # An edited or removed quote must never highlight unrelated text at old offsets.
        text = scene.text.replace("\r\n", "\n").replace("\r", "\n")
        quote = request.form["ai_quote"].replace("\r\n", "\n").replace("\r", "\n")
        if request.form.get("evidence_hash") and (not quote or text[start:end] != quote):
            raise DraftConflict("The dialogue anchor changed. Reopen dialogue before navigating")
        if not quote or text[start:end] != quote:
            start = text.find(quote) if quote else -1
            end = start + len(quote)
    if scene and not scene.historical:
        session["active_scene_id"] = str(scene.id)
    store.commit()
    if scene and not scene.historical and 0 <= start < end <= len(scene.text):
        destination = url_for("workspace.index", ai_start=start, ai_end=end)
    return redirect(destination)


@scene_blueprint.post("/scene/<scene_id>/text")
def save_scene_text(scene_id: str):
    store = active_store()
    _, scene = find_scene(scene_id)
    if scene and not scene.historical:
        previous_text = scene.text
        scene.text = request.form.get("scene_text", "").replace("\r\n", "\n").replace("\r", "\n")
        raw_dialogue = request.form.get("scene_dialogue")
        if raw_dialogue is None and previous_text != scene.text:
            scene.dialogue = [item.detach() for item in scene.dialogue]
        update_dialogue_ranges(scene, json.loads(raw_dialogue) if raw_dialogue else [])
        try:
            raw_comments = request.form.get("scene_comments")
            if raw_comments is not None:
                update_scene_comment_ranges(scene, json.loads(raw_comments))
        except (TypeError, ValueError):
            pass
        update_scene_comment_ranges(scene, [])
        store.commit()
        return ("", 204)
    return jsonify({"error": "Scene not found"}), 404


def _literal_matches(text: str, query: str, case_sensitive: bool = False) -> list[tuple[int, int]]:
    flags = 0 if case_sensitive else re.IGNORECASE
    return [(match.start(), match.end()) for match in re.finditer(re.escape(query), text, flags)]


def _replace_head_text(scene, query: str, replacement: str, replace_all: bool, case_sensitive: bool = False,
                       selected_range: tuple[int, int] | None = None) -> int:
    matches = _literal_matches(scene.text, query, case_sensitive)
    if selected_range is not None:
        matches = [match for match in matches if match == selected_range]
    elif not replace_all:
        matches = matches[:1]
    if not matches:
        return 0
    old_text = scene.text
    pieces = []
    cursor = 0
    for start, end in matches:
        pieces.extend((old_text[cursor:start], replacement))
        cursor = end
    pieces.append(old_text[cursor:])
    new_text = "".join(pieces)

    def map_offset(offset: int) -> int:
        delta = 0
        for start, end in matches:
            mapped_start = start + delta
            if offset < start:
                break
            if offset <= end:
                return mapped_start + min(offset - start, len(replacement))
            delta += len(replacement) - (end - start)
        return offset + delta

    for comment in scene.comments:
        if comment.detached:
            continue
        start, end = map_offset(comment.start), map_offset(comment.end)
        if start < end <= len(new_text):
            comment.start, comment.end = start, end
            comment.quote = new_text[start:end]
        else:
            comment.detach()
    scene.dialogue = [replace(item, start=map_offset(item.start), end=map_offset(item.end)) if not item.detached else item for item in scene.dialogue]
    scene.text = new_text
    update_dialogue_ranges(scene)
    return len(matches)


@scene_blueprint.post("/manuscript/search")
def search_manuscript():
    store = active_store()
    project = store.get()
    data = request.get_json(silent=True) or {}
    query = data.get("query", "")
    scope = data.get("scope", "current_scene")
    case_sensitive = data.get("case_sensitive", False)
    if (not isinstance(query, str) or not isinstance(scope, str) or scope not in {"current_scene", "project"}
            or not isinstance(case_sensitive, bool)):
        return jsonify({"error": "Invalid search request."}), 400
    if not query:
        return jsonify({"matches": []})
    current_id = session.get("active_scene_id")
    current = None
    try:
        current = project.scene(UUID(current_id)) if current_id else None
    except ValueError:
        pass
    if current is None or current.historical:
        return jsonify({"matches": []})
    active_text = data.get("active_text")
    scenes = [current] if scope == "current_scene" else project.current_scenes()
    matches = []
    for scene in scenes:
        text = active_text if scene.id == current.id and isinstance(active_text, str) else scene.text
        ranges = _literal_matches(text, query, case_sensitive)
        count = len(ranges)
        if count:
            match = {"scene_id": str(scene.id), "count": count}
            if data.get("include_ranges") is True:
                match["ranges"] = [{"start": start, "end": end, "quote": text[start:end]} for start, end in ranges]
            matches.append(match)
    return jsonify({"matches": matches})


@scene_blueprint.post("/manuscript/replace")
def replace_manuscript():
    store = active_store()
    project = store.get()
    data = request.get_json(silent=True) or {}
    query, replacement = data.get("query"), data.get("replacement")
    scope = data.get("scope", "current_scene")
    replace_all = data.get("replace_all", True)
    case_sensitive = data.get("case_sensitive", False)
    if (not isinstance(query, str) or not query or not isinstance(replacement, str)
            or not isinstance(scope, str) or scope not in {"current_scene", "project"}
            or not isinstance(replace_all, bool) or not isinstance(case_sensitive, bool)):
        return jsonify({"error": "Enter text to find and a valid replacement scope."}), 400
    current_id = session.get("active_scene_id")
    try:
        current = project.scene(UUID(current_id)) if current_id else None
    except ValueError:
        current = None
    if current is None or current.historical:
        return jsonify({"error": "The active scene is unavailable."}), 404
    from verwrity.project.drafts import DraftConflict
    if ((data.get("active_scene_id") and data["active_scene_id"] != str(current.id))
            or (data.get("scene_base_hash") and data["scene_base_hash"] != scene_source_hash(current))):
        raise DraftConflict("The scene changed. Find the passage again before replacing it.")
    target = data.get("target")
    selected_range = None
    if target is not None:
        if (replace_all or not isinstance(target, dict)
                or type(target.get("start")) is not int or type(target.get("end")) is not int
                or not isinstance(target.get("quote"), str)):
            return jsonify({"error": "Invalid replacement match."}), 400
        selected_range = (target["start"], target["end"])
        if (target.get("scene_id") != str(current.id)
                or selected_range not in _literal_matches(current.text, query, case_sensitive)
                or current.text[target["start"]:target["end"]] != target["quote"]):
            raise DraftConflict("The match changed. Find the passage again before replacing it.")
    scenes = project.current_scenes() if scope == "project" else [current]
    if target is not None:
        scenes = [current]
    changed = []
    for scene in scenes:
        scene_count = _replace_head_text(scene, query, replacement, replace_all, case_sensitive, selected_range)
        if scene_count:
            changed.append({"scene_id": str(scene.id), "count": scene_count, "word_count": len(scene.text.split())})
            if not replace_all:
                break
    count = sum(item["count"] for item in changed)
    if count:
        store.commit()
    return jsonify({
        "count": count,
        "active_text": current.text,
        "active_comments": [comment.as_dict() for comment in current.comments],
        "active_dialogue": [item.as_dict() for item in current.dialogue],
        "scene_word_counts": changed,
    })


@scene_blueprint.post("/scene/<scene_id>/revisions/record")
def record_scene_revision(scene_id: str):
    store = active_store()
    project, scene = find_scene(scene_id)
    if scene is None or scene.historical:
        return jsonify({"error": "Scene not found"}), 404
    sync_active_scene(project)
    revision = scene.record_revision()
    store.commit()
    return jsonify({
        "revision": revision.as_dict(),
        "revisions": [item.as_dict() for item in scene.revisions],
        "head_text": scene.text,
        "head_comments": [comment.as_dict() for comment in scene.comments],
        "head_dialogue": [item.as_dict() for item in scene.dialogue],
    })


@scene_blueprint.post("/scene/<scene_id>/revisions/<revision_id>/restore")
def restore_scene_revision(scene_id: str, revision_id: str):
    store = active_store()
    project, scene = find_scene(scene_id)
    try:
        revision_uuid = UUID(revision_id)
    except ValueError:
        revision_uuid = None
    if scene is None or scene.historical or revision_uuid is None:
        return jsonify({"error": "Scene revision not found"}), 404
    sync_active_scene(project)
    try:
        scene.restore_revision(revision_uuid)
    except ValueError:
        return jsonify({"error": "Scene revision not found"}), 404
    store.commit()
    return jsonify({
        "revisions": [item.as_dict() for item in scene.revisions],
        "head_text": scene.text,
        "head_comments": [comment.as_dict() for comment in scene.comments],
        "head_dialogue": [item.as_dict() for item in scene.dialogue],
        "next_revision_number": scene.next_revision_number(),
    })


def _todo_page(project):
    return next((
        page for page in project.wiki_pages
        if page.title.casefold() in {"todo", "to-do", "to do"}
        or any(alias.casefold() in {"todo", "to-do", "to do"} for alias in page.aliases)
    ), None)


def _append_todo(project, scene, quote: str, body: str):
    page = _todo_page(project)
    task = f"- [ ] {scene.title}: “{' '.join(quote.split())}” — {' '.join(body.split())}"
    if page:
        page_index = project.wiki_pages.index(page)
        revisions = page.revisions + (WikiRevision(
            uuid4(), page.title, page.body, page.tags,
            datetime.now(timezone.utc).isoformat(timespec="seconds"), page.aliases, page.purpose, page.annotations, page.world,
        ),)
        text = f"{page.body}\n{task}" if page.body else task
        updated = replace(page, body=text, revisions=revisions[-100:],
                          annotations=human_edit_annotations(page.body, text, page.annotations))
        project.wiki_pages[page_index] = updated
        return updated
    page = WikiPage(uuid4(), "TODO", task, ("todo",))
    project.wiki_pages.append(page)
    return page


@scene_blueprint.post("/scene/<scene_id>/comments")
def add_scene_comment(scene_id: str):
    store = active_store()
    project, scene = find_scene(scene_id)
    if scene is None or scene.historical:
        return jsonify({"error": "Scene not found"}), 404
    data = request.get_json(silent=True) or {}
    start, end = data.get("start"), data.get("end")
    quote, body = data.get("quote"), data.get("body")
    if (isinstance(start, bool) or isinstance(end, bool) or not isinstance(start, int) or not isinstance(end, int)
            or not (0 <= start < end <= len(scene.text)) or not isinstance(quote, str)
            or scene.text[start:end] != quote or not isinstance(body, str) or not body.strip()):
        return jsonify({"error": "Select a valid text range and enter a comment."}), 400
    body = body.strip()[:5000]
    added_to_todo = data.get("add_to_todo") is True
    comment = ManuscriptComment(uuid4(), start, end, quote, body, added_to_todo=added_to_todo,
                                prefix=scene.text[max(0, start - 48):start], suffix=scene.text[end:end + 48])
    scene.comments.append(comment)
    todo_page = _append_todo(project, scene, quote, body) if added_to_todo else None
    store.commit()
    return jsonify({"comment": comment.as_dict(), "todo_page": page_response(todo_page, project) if todo_page else None})


@scene_blueprint.post("/scene/<scene_id>/comments/<comment_id>/reattach")
def reattach_scene_comment(scene_id: str, comment_id: str):
    store = active_store()
    _, scene = find_scene(scene_id)
    try:
        identity = UUID(comment_id)
    except ValueError:
        identity = None
    comment = next((item for item in scene.comments if item.id == identity), None) if scene else None
    if comment is None or scene.historical:
        return jsonify({"error": "Comment not found"}), 404
    data = request.get_json(silent=True) or {}
    start, end, quote = data.get("start"), data.get("end"), data.get("quote")
    if (type(start) is not int or type(end) is not int or not 0 <= start < end <= len(scene.text)
            or not isinstance(quote, str) or scene.text[start:end] != quote):
        return jsonify({"error": "Select the passage to attach this comment to."}), 400
    comment.start, comment.end, comment.quote = start, end, quote
    comment.detached = False
    store.commit()
    return jsonify({"comment": comment.as_dict()})


@scene_blueprint.post("/scene/<scene_id>/comments/<comment_id>/resolve")
def resolve_scene_comment(scene_id: str, comment_id: str):
    store = active_store()
    _, scene = find_scene(scene_id)
    try:
        comment_uuid = UUID(comment_id)
    except ValueError:
        comment_uuid = None
    comment = next((item for item in scene.comments if item.id == comment_uuid), None) if scene else None
    if comment is None or scene.historical:
        return jsonify({"error": "Comment not found"}), 404
    resolved = (request.get_json(silent=True) or {}).get("resolved")
    if not isinstance(resolved, bool):
        return jsonify({"error": "A resolved state is required."}), 400
    comment.resolved = resolved
    store.commit()
    return jsonify({"comment": comment.as_dict()})


@scene_blueprint.post("/scene/<scene_id>/comments/<comment_id>/delete")
def delete_scene_comment(scene_id: str, comment_id: str):
    store = active_store()
    _, scene = find_scene(scene_id)
    try:
        comment_uuid = UUID(comment_id)
    except ValueError:
        comment_uuid = None
    comment = next((item for item in scene.comments if item.id == comment_uuid), None) if scene else None
    if comment is None or scene.historical:
        return jsonify({"error": "Comment not found"}), 404
    scene.comments.remove(comment)
    store.commit()
    return jsonify({"deleted": True, "id": comment_id})


@scene_blueprint.post("/scene/<scene_id>/remove")
def remove_scene(scene_id: str):
    store = active_store()
    project, scene = find_scene(scene_id)
    if scene:
        sync_active_scene(project)
        scene.historical = True
        if session.get("active_scene_id") == str(scene.id):
            session.pop("active_scene_id", None)
        store.commit()
    return redirect(url_for("workspace.index"))


@scene_blueprint.get("/scene/<scene_id>/history")
def view_historical_scene(scene_id: str):
    _, scene = find_scene(scene_id)
    if scene is None or not scene.historical:
        abort(404)
    return render_template("historical_scene.html", scene=scene)


@scene_blueprint.post("/scene/<scene_id>/restore")
def restore_scene(scene_id: str):
    store = active_store()
    project, scene = find_scene(scene_id)
    if scene is None or not scene.historical:
        abort(404)
    sync_active_scene(project)
    scene.historical = False
    session["active_scene_id"] = str(scene.id)
    store.commit()
    return redirect(url_for("workspace.index"))


@scene_blueprint.post("/scene/<scene_id>/permanently-delete")
def permanently_delete_scene(scene_id: str):
    store = active_store()
    project, scene = find_scene(scene_id)
    if scene is None or not scene.historical:
        abort(404)
    sync_active_scene(project)
    project.scenes.remove(scene)
    project.storyboard_cells = {
        key: value for key, value in project.storyboard_cells.items()
        if key[0] != scene.id
    }
    if session.get("active_scene_id") == str(scene.id):
        session.pop("active_scene_id", None)
    store.commit()
    return redirect(url_for("workspace.index"))


@scene_blueprint.post("/scene/<scene_id>/move")
def move_scene(scene_id: str):
    store = active_store()
    project, scene = find_scene(scene_id)
    if scene and not scene.historical:
        current = project.current_scenes()
        index = current.index(scene)
        target = index + (-1 if request.form.get("direction") == "up" else 1)
        if 0 <= target < len(current):
            other = current[target]
            a, b = project.scenes.index(scene), project.scenes.index(other)
            project.scenes[a], project.scenes[b] = project.scenes[b], project.scenes[a]
            store.commit()
    return redirect(url_for("workspace.index"))


@scene_blueprint.post("/storyboard/save")
def save_storyboard():
    store = active_store()
    project = store.get()
    current = project.current_scenes()
    submitted_ids = request.form.getlist("scene_id")
    try:
        ordered = [project.scene(UUID(scene_id)) for scene_id in submitted_ids]
    except ValueError:
        ordered = []
    valid_order = (
        len(ordered) == len(current)
        and all(scene is not None and not scene.historical for scene in ordered)
        and {scene.id for scene in ordered} == {scene.id for scene in current}
    )
    if valid_order:
        for scene in current:
            scene.title = request.form.get(f"title_{scene.id}", scene.title).strip()[:500] or scene.title
            scene.summary = request.form.get(f"summary_{scene.id}", scene.summary).strip()
            note_color = request.form.get(f"note_color_{scene.id}", "")
            if NOTE_COLOR_RE.fullmatch(note_color):
                scene.note_color = note_color.lower()
        reordered = iter(ordered)
        project.scenes = [next(reordered) if not scene.historical else scene for scene in project.scenes]
        intent = request.form.get("intent", "save")
        if intent == "add":
            title = request.form.get("new_scene_title", "").strip() or "Untitled scene"
            summary = request.form.get("new_scene_summary", "").strip()
            new_scene = Scene(uuid4(), title, summary=summary)
            project.scenes.append(new_scene)
            session["active_scene_id"] = str(new_scene.id)
        elif intent == "delete":
            try:
                scene = project.scene(UUID(request.form.get("delete_scene_id", "")))
            except ValueError:
                scene = None
            if scene and not scene.historical:
                scene.historical = True
                if session.get("active_scene_id") == str(scene.id):
                    session.pop("active_scene_id", None)
        store.commit()
        if intent == "add":
            return redirect(url_for("workspace.storyboard"))
        if intent == "view_grid":
            return redirect(url_for("workspace.storyboard", view="grid"))
    return redirect(url_for("workspace.index"))
