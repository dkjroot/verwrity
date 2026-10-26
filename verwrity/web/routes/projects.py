"""Project library, archive, and draft routes."""

from copy import deepcopy
from io import BytesIO
from uuid import UUID, uuid4

from flask import Blueprint, current_app, flash, jsonify, redirect, render_template, request, send_file, session, url_for

from verwrity.domain.story import Scene, StoryProject
from verwrity.domain.project_features import ProjectFeatures
from verwrity.project.drafts import DraftConflict
from verwrity.project.archive import export_project, import_project
from verwrity.web.services.workspace import active_store, draft_repository, sync_active_scene, workspace_context


project_blueprint = Blueprint("projects", __name__)


@project_blueprint.route("/project/features", methods=["GET", "POST"])
def project_features():
    store = active_store()
    project = store.get()
    changed = False
    if request.method == "POST":
        if request.headers.get("X-Verwrity-Project-Id") != str(project.project_id):
            raise DraftConflict("The active project changed. Reopen project features before saving.")
        data = request.get_json(silent=True)
        if not isinstance(data, dict) or set(data) != {"features", "expected_features"}:
            raise ValueError("Expected project features and their previous values")
        features = ProjectFeatures.from_dict(data["features"])
        expected = ProjectFeatures.from_dict(data["expected_features"])
        if expected != project.features:
            raise DraftConflict("Project features changed elsewhere. Reopen settings to review them.")
        changed = features != project.features
        if changed:
            # This mutation never synchronizes or replaces the editor's prose buffer.
            project.features = features
            store.commit()
    response = jsonify(project_id=str(project.project_id), features=project.features.as_dict(), changed=changed)
    response.headers["Cache-Control"] = "no-store"
    return response


@project_blueprint.post("/project/library-save")
def library_save_project():
    current_app.logger.info("Project: synchronizing editor and saving named archive")
    store = active_store()
    project = store.get()
    sync_active_scene(project)
    project.title = request.form.get("project_title", "").strip() or "Untitled story"
    store.commit()
    destination = current_app.config["PROJECT_LIBRARY"].save(current_app.config["USER_ID"], project)
    store.acknowledge_recovery()
    session.pop("recovered_project_needs_named_save", None)
    session["has_chosen_project"] = True
    flash(f"Project saved as {destination.name}.", "success")
    if request.accept_mimetypes.best == "application/json":
        return jsonify({"redirect": url_for("workspace.index"), "filename": destination.name})
    return redirect(url_for("workspace.index"))


@project_blueprint.post("/project/duplicate")
def duplicate_project():
    current_app.logger.info("Project: creating a separate archive and identity")
    project = active_store().get()
    sync_active_scene(project)
    title = request.form.get("duplicate_title", "").strip() or f"Copy of {project.title}"
    destination = current_app.config["PROJECT_LIBRARY"].duplicate(current_app.config["USER_ID"], deepcopy(project), title)
    flash(f"Project duplicated as {destination.name}.", "success")
    return redirect(url_for("workspace.index"))


@project_blueprint.post("/project/library-open")
def library_open_project():
    current_app.logger.info("Project: loading named archive")
    filename = request.form.get("project_filename", "")
    try:
        project = current_app.config["PROJECT_LIBRARY"].load(current_app.config["USER_ID"], filename)
    except (ValueError, OSError) as error:
        current_app.logger.warning("Project: named archive could not be loaded (%s)", type(error).__name__)
        return redirect(url_for("workspace.index"))
    active_store().open(project)
    session.pop("recovered_project_needs_named_save", None)
    session["has_chosen_project"] = True
    return redirect(url_for("workspace.index"))


@project_blueprint.post("/project/recovery/open")
def open_recovery_project():
    try:
        project_id = UUID(request.form.get("project_id", ""))
    except ValueError:
        return redirect(url_for("workspace.index"))
    recovery = draft_repository().latest(project_id)
    if recovery:
        store = active_store()
        store.open(recovery.project)
        store.recovered_from_disk = True
        session.pop("active_scene_id", None)
    return redirect(url_for("workspace.index"))


@project_blueprint.post("/project/new")
def new_project():
    current_app.logger.info("Project: creating named project with initial scene")
    title = request.form.get("project_title", "").strip() or "Untitled story"
    if len(title) > 500:
        raise ValueError("Enter a project name up to 500 characters")
    scene = Scene(uuid4(), "Scene 1", "", "")
    project = StoryProject(title, scenes=[scene])
    # Publish the named file before switching the active working copy. A failed
    # library write must leave the previous project selected and recoverable.
    current_app.config["PROJECT_LIBRARY"].save(current_app.config["USER_ID"], project)
    active_store().replace(project)
    session.pop("recovered_project_needs_named_save", None)
    session["active_scene_id"] = str(scene.id)
    flash("New project saved. Scene 1 is ready to write.", "success")
    session["has_chosen_project"] = True
    return redirect(url_for("workspace.index"))


@project_blueprint.post("/project/save")
def save_project():
    current_app.logger.info("Project: synchronizing editor and exporting portable archive")
    project = active_store().get()
    sync_active_scene(project)
    project.title = request.form.get("project_title", "").strip() or "Untitled story"
    filename, data = export_project(project)
    return send_file(BytesIO(data), as_attachment=True, download_name=filename, mimetype="application/zip")


@project_blueprint.post("/project/open")
def open_project():
    current_app.logger.info("Project: validating imported archive")
    upload = request.files.get("project_file")
    if upload is None or not upload.filename:
        return redirect(url_for("workspace.index"))
    try:
        project = import_project(upload.read())
    except ValueError as exc:
        current_app.logger.warning("Project: imported archive rejected (%s)", type(exc).__name__)
        return render_template("workspace.html", **workspace_context(), error=str(exc)), 400
    active_store().replace(project)
    session.pop("recovered_project_needs_named_save", None)
    session["has_chosen_project"] = True
    return redirect(url_for("workspace.index"))


@project_blueprint.post("/project/recovery/continue")
def continue_recovered_project():
    current_app.logger.info("Project: continuing recovered draft")
    store = active_store()
    store.acknowledge_recovery()
    session["recovered_project_needs_named_save"] = True
    session["has_chosen_project"] = True
    return redirect(url_for("workspace.index"))


@project_blueprint.post("/project/recovery/discard")
def discard_recovered_project():
    current_app.logger.info("Project: restoring saved project or blank project after discarding draft")
    filename = request.form.get("saved_project_filename", "")
    project = StoryProject("Untitled story")
    if filename:
        try:
            project = current_app.config["PROJECT_LIBRARY"].load(current_app.config["USER_ID"], filename)
        except (ValueError, OSError) as error:
            current_app.logger.warning("Project: saved archive could not be restored; recovered draft retained (%s)", type(error).__name__)
            flash("The saved project could not be opened; the recovered draft is still available.", "error")
            return redirect(url_for("workspace.index"))
    store = active_store()
    recovered_id = store.get().project_id
    store.replace(project)
    # Publish a readable replacement before removing discarded recovery files.
    if store.drafts:
        store.drafts.discard(recovered_id, keep_current=project.project_id == recovered_id)
    session.pop("recovered_project_needs_named_save", None)
    session.pop("active_scene_id", None)
    session["has_chosen_project"] = True
    flash("Recovered changes discarded." if filename else "Recovered draft discarded; a blank project is ready.", "success")
    return redirect(url_for("workspace.index"))


@project_blueprint.post("/project/manuscript.txt")
def download_manuscript():
    from verwrity.project.manuscript_export import plain_manuscript
    from verwrity.project.archive import safe_filename
    from verwrity.web.services.workspace import scene_source_hash
    store = active_store()
    project = deepcopy(store.get())
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        raise ValueError("Expected a manuscript snapshot")
    include_scene_details = data.get("include_scene_details", True)
    if not isinstance(include_scene_details, bool):
        raise ValueError("Choose whether to include scene titles and descriptions")
    if request.headers.get("X-Verwrity-Project-Id") != str(project.project_id):
        raise DraftConflict("The active project changed. Reopen the manuscript before exporting")
    scene_id = data.get("scene_id")
    if scene_id:
        scene = project.scene(UUID(scene_id))
        if (scene is None or scene.historical or data.get("source_hash") != scene_source_hash(scene)
                or not isinstance(data.get("text"), str)):
            raise DraftConflict("The source scene changed. Your editor buffer is kept here")
        scene.text = data["text"]
    response = send_file(BytesIO(plain_manuscript(project, include_scene_details=include_scene_details).encode("utf-8")), mimetype="text/plain",
                         as_attachment=True, download_name=safe_filename(project.title) + ".txt")
    response.headers["Cache-Control"] = "no-store"
    return response
