"""Session-scoped workspace state and view context."""

from __future__ import annotations

from copy import deepcopy
import json
from hashlib import sha256
from pathlib import Path
from uuid import UUID, uuid4

from flask import current_app, request, session

from verwrity.project.library import ProjectLibrary
from verwrity.project.store import ProjectStore
from verwrity.project.files import PROJECT_LOCK
from verwrity.project.drafts import DraftRepository, DraftConflict
from verwrity.analysis.manuscript import MANUSCRIPT_TASKS
from verwrity.analysis.wiki import page_hash, manuscript_hash
from verwrity.web.services.scene_metadata import METADATA_FIELDS
from verwrity.domain.dialogue import update_dialogue_ranges
from verwrity.domain.dialogue import update_dialogue_ranges
from verwrity.domain.world import record_data


def draft_repository() -> DraftRepository:
    repository = DraftRepository(Path(current_app.config["PROJECT_DRAFT_ROOT"]), current_app.config["USER_ID"])
    # The pre-authentication layout belonged exclusively to local-user.
    # Never assign those unscoped files to a newly introduced account.
    if (current_app.config["USER_ID"] == "local-user"
            and Path(current_app.config["PROJECT_DRAFT_ROOT"]) == Path("user_files")
            and not current_app.config.get("LEGACY_DRAFTS_CHECKED")):
        repository.migrate_legacy(Path("user_files") / ".drafts")
        current_app.config["LEGACY_DRAFTS_CHECKED"] = True
    return repository


def active_store() -> ProjectStore:
    """Return the recoverable draft store for this browser session."""
    with PROJECT_LOCK:
        session_id = session.setdefault("project_session_id", uuid4().hex)
        key = (current_app.config["USER_ID"], session_id)
        stores = current_app.config["PROJECT_STORES"]
        if key not in stores:
            if (not session.get("project_id") and current_app.config["USER_ID"] == "local-user"
                    and Path(current_app.config["PROJECT_DRAFT_ROOT"]) == Path("user_files")):
                legacy_id = DraftRepository.legacy_project_id(Path("user_files") / ".drafts", session_id)
                if legacy_id:
                    session["project_id"] = str(legacy_id)
            repository = draft_repository()
            project = deepcopy(current_app.config["INITIAL_PROJECT"])
            selected = session.get("project_id")
            if selected:
                try:
                    recovery = repository.latest(UUID(selected))
                except ValueError:
                    recovery = None
            else:
                candidates = repository.list()
                recovery = candidates[0] if len(candidates) == 1 else None
            if recovery:
                project = recovery.project
            # Selection belongs here. A constructor fallback must not silently
            # choose the initial project's draft when several recoveries exist.
            stores[key] = ProjectStore(project, drafts=repository, recover=False)
            stores[key].recovered_from_disk = recovery is not None
        project_id = str(stores[key].get().project_id)
        # A read-only request must not republish its older scene selection in a
        # session cookie after a concurrent navigation has selected another scene.
        if session.get("project_id") != project_id:
            session["project_id"] = project_id
        return stores[key]


def workspace_context() -> dict[str, object]:
    library: ProjectLibrary = current_app.config["PROJECT_LIBRARY"]
    store = active_store()
    project = store.get()
    recovery = None
    if store.recovered_from_disk:
        named = library.find_project_id(current_app.config["USER_ID"], project.project_id)
        if named is not None and named[1] == project:
            store.acknowledge_recovery()
            session["has_chosen_project"] = True
            session.pop("recovered_project_needs_named_save", None)
        else:
            recovery = {
                "project_title": project.title,
                "saved_filename": named[0] if named else "",
                "saved_title": named[1].title if named else "",
            }
    selected_id = session.get("active_scene_id")
    try:
        selected = project.scene(UUID(selected_id)) if selected_id else None
    except ValueError:
        selected = None
    if selected is None:
        selected = next(iter(project.current_scenes()), None)
        if selected:
            session["active_scene_id"] = str(selected.id)
    definitions = current_app.extensions["text_analyses"].load(current_app.config["USER_ID"])
    show_start = not recovery and not session.get("has_chosen_project", False)
    named = library.find_project_id(current_app.config["USER_ID"], project.project_id)
    return {
        "manuscript_tasks": MANUSCRIPT_TASKS,
        "scene_metadata_fields": METADATA_FIELDS,
        "text_analyses": definitions,
        "text_analysis_definitions": [item.as_dict() for item in definitions],
        "project": project,
        "world_page_data": {str(page.id): record_data(page.world) for page in project.wiki_pages},
        "world_revision_data": {str(revision.id): record_data(revision.world) for page in project.wiki_pages for revision in page.revisions},
        "wiki_page_hashes": {str(page.id): page_hash(page) for page in project.wiki_pages},
        "wiki_source_hash": manuscript_hash(project),
        "active_scene": selected,
        "scene_source_hash": scene_source_hash(selected) if selected else "",
        "scene_comments": [comment.as_dict() for comment in selected.comments] if selected else [],
        "scene_dialogue": [item.as_dict() for item in selected.dialogue] if selected else [],
        "scene_dialogue": [item.as_dict() for item in selected.dialogue] if selected else [],
        "scene_revisions": [revision.as_dict() for revision in selected.revisions] if selected else [],
        "library_projects": library.list(current_app.config["USER_ID"]),
        "recovery_projects": draft_repository().list() if show_start else [],
        "show_start_dialog": show_start,
        "recovery": recovery,
        "recovery_needs_save": bool(recovery or session.get("recovered_project_needs_named_save")),
        "project_needs_save": named is None or named[1] != project,
        "wiki_error": session.pop("wiki_error", None),
    }


def sync_active_scene(project, text: str | None = None) -> None:
    """Copy the active editor buffer into its canonical scene."""
    active_id = session.get("active_scene_id")
    if not active_id:
        return
    try:
        scene = project.scene(UUID(active_id))
    except ValueError:
        scene = None
    if scene and not scene.historical:
        expected = request.form.get("scene_base_hash")
        if expected and expected != scene_source_hash(scene):
            raise DraftConflict("This scene changed in another tab. Your edits have been kept; copy them before reopening the project.")
        raw_text = request.form.get("manuscript", scene.text) if text is None else text
        previous_text = scene.text
        previous_text = scene.text
        scene.text = raw_text.replace("\r\n", "\n").replace("\r", "\n")
        raw_dialogue = request.form.get("scene_dialogue")
        if raw_dialogue is None and previous_text != scene.text:
            scene.dialogue = [item.detach() for item in scene.dialogue]
        update_dialogue_ranges(scene, json.loads(raw_dialogue) if raw_dialogue else [])
        raw_dialogue = request.form.get("scene_dialogue")
        if raw_dialogue is None and previous_text != scene.text:
            scene.dialogue = [item.detach() for item in scene.dialogue]
        update_dialogue_ranges(scene, json.loads(raw_dialogue) if raw_dialogue else [])
        raw_comments = request.form.get("scene_comments")
        if raw_comments is not None:
            try:
                update_scene_comment_ranges(scene, json.loads(raw_comments))
            except (TypeError, ValueError, json.JSONDecodeError):
                pass
        update_scene_comment_ranges(scene, [])


def scene_source_hash(scene) -> str:
    return sha256(scene.text.encode("utf-8")).hexdigest()


def update_scene_comment_ranges(scene, submitted) -> None:
    """Persist editor-mapped comment anchors without accepting new comment data."""
    if not isinstance(submitted, list):
        return
    by_id = {str(comment.id): comment for comment in scene.comments}
    for item in submitted:
        if not isinstance(item, dict):
            continue
        comment = by_id.get(str(item.get("id", "")))
        start, end = item.get("start"), item.get("end")
        if comment is not None and item.get("detached") is True:
            comment.detach()
            continue
        if comment is not None and comment.detached and item.get("restored") is not True:
            continue  # Reattachment requires an explicit validated author action.
        if (comment is None or isinstance(start, bool) or isinstance(end, bool)
                or not isinstance(start, int) or not isinstance(end, int)
                or not (0 <= start < end <= len(scene.text))):
            continue
        quote = scene.text[start:end]
        if comment.detached and quote != comment.quote:
            continue  # Undo can recover the mapped quote, never an arbitrary match.
        if quote:
            comment.start, comment.end, comment.quote = start, end, quote
            comment.detached = False
    for comment in scene.comments:
        if (not comment.detached and (comment.start is None or comment.end is None
                or not 0 <= comment.start < comment.end <= len(scene.text)
                or scene.text[comment.start:comment.end] != comment.quote)):
            comment.detach()
