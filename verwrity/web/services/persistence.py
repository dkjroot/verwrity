"""Serialize local project requests and preserve working copies on failures."""

from copy import deepcopy
from uuid import UUID
from flask import current_app, g, jsonify, request, session

from verwrity.project.drafts import DraftConflict
from verwrity.project.files import PROJECT_LOCK
from verwrity.web.services.workspace import active_store, scene_source_hash


def configure_project_persistence(app):
    @app.before_request
    def serialize_project_requests():
        endpoint = request.endpoint or ""
        if not (endpoint in {"workspace.index", "workspace.storyboard"}
                or endpoint.startswith(("scenes.", "wiki.", "projects.", "world.", "fingal_transfer.", "dialogue.", "scene_structure."))
                or endpoint == "analysis.update_spelling_dictionary"
                or endpoint in {"import_vocabulary.read_words", "import_vocabulary.save_words"}):
            return
        PROJECT_LOCK.acquire()
        g.project_lock_held = True
        store = active_store()
        if request.method not in {"GET", "HEAD"}:
            g.project_store = store
            g.project_snapshot = deepcopy(store.get())
            g.project_generation = store.generation
            g.project_recovery = store.recovered_from_disk
            # Opening a project is also how an author refreshes a stale session.
            if endpoint not in {"projects.library_open_project", "projects.new_project",
                                "projects.open_project", "projects.open_recovery_project"}:
                store.ensure_current()
            expected = request.headers.get("X-Verwrity-Scene-Hash")
            expected_project = request.headers.get("X-Verwrity-Project-Id") or request.form.get("expected_project_id")
            if expected_project and expected_project != str(store.get().project_id):
                raise DraftConflict("The active project changed in another tab. Your edits have been kept here.")
            scene_id = (request.view_args or {}).get("scene_id")
            if expected and scene_id:
                try:
                    scene = store.get().scene(scene_id if isinstance(scene_id, UUID) else UUID(scene_id))
                except ValueError:
                    scene = None
                if scene and scene_source_hash(scene) != expected:
                    raise DraftConflict("This scene changed in another tab. Your edits have been kept; copy them before reopening the project.")

    def release_project_request(failed=False):
        try:
            if (failed and hasattr(g, "project_snapshot") and g.project_store.get() != g.project_snapshot
                    and g.project_store.generation == g.project_generation):
                store = g.project_store
                store.rollback(g.project_snapshot, g.project_generation, g.project_recovery)
        finally:
            if getattr(g, "project_lock_held", False):
                g.project_lock_held = False
                PROJECT_LOCK.release()

    @app.after_request
    def complete_project_request(response):
        if response.status_code < 400 and hasattr(g, "project_store"):
            project_id = str(g.project_store.get().project_id)
            if session.get("project_id") != project_id:
                session["project_id"] = project_id
            scene_id = (request.view_args or {}).get("scene_id") or session.get("active_scene_id")
            if scene_id:
                try:
                    scene = g.project_store.get().scene(scene_id if isinstance(scene_id, UUID) else UUID(scene_id))
                except ValueError:
                    scene = None
                if scene:
                    response.headers["X-Verwrity-Scene-Hash"] = scene_source_hash(scene)
        release_project_request(response.status_code >= 400)
        return response

    @app.teardown_request
    def unlock_project_request(error):
        release_project_request(error is not None)

    @app.errorhandler(DraftConflict)
    def draft_conflict(error):
        return jsonify({"error": str(error), "conflict": True}), 409

    @app.errorhandler(ValueError)
    def invalid_project_write(error):
        if not hasattr(g, "project_snapshot"):
            raise error
        return jsonify({"error": str(error)}), 400

    @app.errorhandler(OSError)
    def failed_project_write(error):
        if not hasattr(g, "project_snapshot"):
            raise error
        current_app.logger.warning("Project persistence: write failed (%s; errno=%s; winerror=%s)",
                                   type(error).__name__, error.errno, getattr(error, "winerror", None))
        return jsonify({"error": "Could not write the project. Your existing save is intact; keep your edits and retry."}), 503
