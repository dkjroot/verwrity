"""Persistence routes for the editable storyboard grid."""

from uuid import UUID, uuid4

from flask import Blueprint, redirect, request, url_for

from verwrity.domain.story import StoryboardColumn
from verwrity.web.services.workspace import active_store


storyboard_blueprint = Blueprint("storyboard", __name__)


@storyboard_blueprint.post("/storyboard/grid/save")
def save_grid():
    store = active_store()
    project = store.get()
    scenes = project.current_scenes()
    columns = project.storyboard_columns
    try:
        scene_ids = [UUID(value) for value in request.form.getlist("scene_id")]
        column_ids = [UUID(value) for value in request.form.getlist("column_id")]
    except ValueError:
        scene_ids, column_ids = [], []

    valid_scenes = len(scene_ids) == len(scenes) and set(scene_ids) == {scene.id for scene in scenes}
    valid_columns = len(column_ids) == len(columns) and set(column_ids) == {column.id for column in columns}
    if valid_scenes and valid_columns:
        for scene in scenes:
            title = request.form.get(f"scene_title_{scene.id}", scene.title).strip()
            scene.title = title or scene.title
            scene.summary = request.form.get(f"scene_summary_{scene.id}", scene.summary).strip()
            for column in columns:
                project.set_storyboard_value(
                    scene.id,
                    column.id,
                    request.form.get(f"cell_{scene.id}_{column.id}", "").strip(),
                )
        for column in columns:
            title = request.form.get(f"column_title_{column.id}", column.title).strip()
            column.title = title or column.title

        intent = request.form.get("intent", "return")
        if intent == "add_column":
            title = request.form.get("new_column_title", "").strip()
            if title:
                project.storyboard_columns.append(StoryboardColumn(uuid4(), title))
        elif intent == "delete_column":
            try:
                column_id = UUID(request.form.get("delete_column_id", ""))
            except ValueError:
                column_id = None
            if column_id and any(column.id == column_id for column in columns):
                project.storyboard_columns = [column for column in columns if column.id != column_id]
                project.storyboard_cells = {
                    key: value for key, value in project.storyboard_cells.items()
                    if key[1] != column_id
                }
        store.commit()

        if intent == "view_notes":
            return redirect(url_for("workspace.storyboard", view="notes"))
        if intent != "return":
            return redirect(url_for("workspace.storyboard", view="grid"))
    return redirect(url_for("workspace.index"))
