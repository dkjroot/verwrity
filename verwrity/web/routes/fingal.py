"""Explicit preview/apply boundaries for portable game files."""

from io import BytesIO
import json
from uuid import UUID

from flask import Blueprint, abort, current_app, jsonify, request, session, send_file, url_for
from itsdangerous import URLSafeTimedSerializer, BadData

from verwrity.domain.fingal import MAX_FINGAL_BYTES
from verwrity.project.archive import export_project, safe_filename
from verwrity.project.drafts import DraftConflict
from verwrity.project.fingal import import_story, export_story, review
from verwrity.web.services.workspace import active_store
from verwrity.web.services.world import world_hash


# The shared persistence middleware includes this namespace in its lock/rollback boundary.
fingal_blueprint = Blueprint("fingal_transfer", __name__)


def _project():
    project = active_store().get()
    if not project.features.fingal_mode:
        abort(404)
    if request.headers.get("X-Verwrity-Project-Id") != str(project.project_id):
        raise DraftConflict("The active project changed. Reopen the Fingal file review.")
    return project


def _signer():
    return URLSafeTimedSerializer(current_app.secret_key, salt="fingal-transfer-v1")


def _token(project, action, **data):
    return _signer().dumps({"project_id": str(project.project_id), "session_id": session["project_session_id"], "action": action, **data})


def _proposal(project, action):
    data = request.get_json(silent=True)
    try:
        payload = _signer().loads(data["proposal"], max_age=3600)
    except (BadData, KeyError, TypeError):
        raise DraftConflict("This file review expired or is invalid. Preview it again.") from None
    if (payload.get("project_id") != str(project.project_id) or payload.get("session_id") != session["project_session_id"]
            or payload.get("action") != action):
        raise DraftConflict("This file review belongs to another project or browser session.")
    return payload


@fingal_blueprint.post("/project/fingal/import/preview")
def import_preview():
    project = _project()
    upload = request.files.get("story_file")
    if upload is None or not upload.filename:
        raise ValueError("Choose a Fingal story JSON file")
    data = upload.read(MAX_FINGAL_BYTES + 1)
    candidate = import_story(data, upload.filename)
    export_project(candidate)  # A preview must be recoverable under archive limits.
    report = review(candidate)
    report["warnings"].append("Import creates a separate Verwrity project with no manuscript scenes. Your current project's saved data stays available.")
    # A valid imported source may be incomplete for play; authoring it is allowed.
    report["export_errors"] = report.pop("errors")
    report["proposal"] = _token(project, "import", source=candidate.fingal_source.as_dict(), candidate_id=str(candidate.project_id))
    return jsonify(report)


@fingal_blueprint.post("/project/fingal/import/apply")
def import_apply():
    project = _project()
    payload = _proposal(project, "import")
    source = payload["source"]
    candidate = import_story(json.dumps(source["bundle"], ensure_ascii=False), source["source_name"], UUID(payload["candidate_id"]))
    store = active_store()
    store.replace(candidate)
    session.pop("active_scene_id", None)
    session["has_chosen_project"] = True
    session["recovered_project_needs_named_save"] = True
    first = next((p for p in candidate.wiki_pages if p.world.location), None)
    return jsonify(redirect=url_for("workspace.index", wiki_page=first.id if first else ""))


@fingal_blueprint.post("/project/fingal/export/preview")
def export_preview():
    project = _project()
    report = review(project)
    if not report["errors"]:
        report["proposal"] = _token(project, "export", revision=world_hash(project))
    return jsonify(report)


@fingal_blueprint.post("/project/fingal/export/download")
def export_download():
    project = _project()
    payload = _proposal(project, "export")
    if payload["revision"] != world_hash(project):
        raise DraftConflict("World data changed after this review. Preview the export again.")
    report = review(project)
    if report["errors"]:
        raise ValueError("; ".join(report["errors"]))
    bundle, _ = export_story(project)
    return send_file(BytesIO((json.dumps(bundle, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode()),
        as_attachment=True, download_name=safe_filename(project.title) + ".fingal.json", mimetype="application/json")
