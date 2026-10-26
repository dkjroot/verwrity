"""Routes for rendering the main writing workspace."""

from flask import Blueprint, current_app, jsonify, render_template, request

from verwrity.web.services.workspace import active_store, workspace_context
from verwrity.project.files import PROJECT_LOCK
from verwrity.web.services.workspace_tips import support_links, workspace_tips


workspace_blueprint = Blueprint("workspace", __name__)


@workspace_blueprint.get("/health")
def health():
    """Check server reachability without loading projects or calling providers."""
    response = jsonify(service="verwrity", status="ok")
    response.headers["Cache-Control"] = "no-store"
    return response


@workspace_blueprint.get("/")
def index():
    return render_template("workspace.html", **workspace_context(), workspace_tips=workspace_tips(current_app.config))


@workspace_blueprint.get("/speed-reader/snapshot")
def speed_reader_snapshot():
    """Read current prose only; the browser overlays its unsaved active buffer."""
    with PROJECT_LOCK:
        project = active_store().get()
        if request.args.get("project_id") != str(project.project_id):
            return jsonify(error="The project changed. Reopen the speed reader."), 409
        scenes = project.current_scenes()
        if sum(len(scene.text) for scene in scenes) > 5_000_000:
            return jsonify(error="This manuscript is too large for speed reader mode (5 million characters)."), 413
        response = jsonify(project_id=str(project.project_id), scenes=[
            {"id": str(scene.id), "text": scene.text} for scene in scenes
        ])
        response.headers["Cache-Control"] = "no-store"
        return response


@workspace_blueprint.get("/storyboard")
def storyboard():
    context = workspace_context()
    view = "grid" if request.args.get("view") == "grid" else "notes"
    return render_template("storyboard.html", **context, view=view)


@workspace_blueprint.get("/help")
def help_page():
    return render_template("help.html", support_links=support_links(current_app.config))
