"""Stale-safe, atomic split/join operations using saved editor snapshots."""
from uuid import UUID
from flask import Blueprint, jsonify, request, session
from verwrity.domain.scene_operations import split_scene, join_scenes
from verwrity.web.services.workspace import active_store, scene_source_hash
from verwrity.project.drafts import DraftConflict
from verwrity.analysis.dialogue import fingerprint

structure_blueprint = Blueprint("scene_structure", __name__)


@structure_blueprint.get("/scene/<uuid:scene_id>/structure")
def structure_info(scene_id):
    project = active_store().get()
    current = project.current_scenes()
    scene = project.scene(scene_id)
    if scene not in current:
        return jsonify(error="Current scene not found"), 404
    index = current.index(scene)
    later = current[index + 1] if index + 1 < len(current) else None

    def info(item):
        return {"id": str(item.id), "title": item.title, "summary": item.summary,
                "metadata": item.metadata.as_dict(), "source_hash": scene_source_hash(item)} if item else None
    return jsonify(earlier=info(scene), later=info(later), snapshot=fingerprint(project))


@structure_blueprint.post("/scene/<uuid:scene_id>/structure/<operation>")
def change_structure(scene_id, operation):
    store = active_store()
    project = store.get()
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        raise ValueError("Expected a structural edit request")
    scene = project.scene(scene_id)
    if scene is None or scene.historical:
        return jsonify(error="Current scene not found"), 404
    if (request.headers.get("X-Verwrity-Project-Id") != str(project.project_id)
            or data.get("snapshot") != fingerprint(project)):
        raise DraftConflict("Scene text, order or context changed. Reopen the structural edit")
    title, summary = data.get("title"), data.get("summary")
    if not isinstance(title, str) or not title.strip() or len(title) > 500 or not isinstance(summary, str) or len(summary) > 5000:
        raise ValueError("Enter a title up to 500 characters and description up to 5,000 characters")
    if operation == "split":
        result = split_scene(project, scene, data.get("offset"), title.strip(), summary)
    elif operation == "join":
        later = project.scene(UUID(data.get("later_id", "")))
        result = join_scenes(project, scene, later, title.strip(), summary, data.get("separator", "\n\n"))
    else:
        raise ValueError("Unknown scene operation")
    store.commit()
    session["active_scene_id"] = str(result.id)
    return jsonify(scene_id=str(result.id), redirect="/")
