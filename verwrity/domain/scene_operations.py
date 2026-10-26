"""Explicit structural edits preserving original heads and source identities."""
from dataclasses import asdict, dataclass, replace
from datetime import datetime, timezone
from uuid import UUID, uuid4
from verwrity.domain.story import Scene


@dataclass(frozen=True, slots=True)
class SceneChange:
    id: UUID
    kind: str
    earlier_id: UUID
    later_id: UUID
    offset: int
    separator: str = ""
    recorded_at: str = ""
    earlier_title: str = ""
    earlier_summary: str = ""
    later_title: str = ""
    later_summary: str = ""

    def as_dict(self):
        return {**asdict(self), **{key: str(getattr(self, key)) for key in ("id", "earlier_id", "later_id")}}

    @classmethod
    def from_dict(cls, data):
        if (not isinstance(data, dict) or data.get("kind") not in {"split", "join"}
                or type(data.get("offset")) is not int or data["offset"] < 0
                or not isinstance(data.get("separator", ""), str)
                or not isinstance(data.get("recorded_at", ""), str)
                or any(not isinstance(data.get(key), str) for key in ("id", "earlier_id", "later_id"))
                or any(not isinstance(data.get(key, ""), str) for key in ("earlier_title", "earlier_summary", "later_title", "later_summary"))
                or data.get("earlier_id") == data.get("later_id")
                or data.get("separator", "") not in {"", "\n", "\n\n"}):
            raise ValueError("Invalid scene change")
        return cls(UUID(data["id"]), data["kind"], UUID(data["earlier_id"]), UUID(data["later_id"]),
                   data["offset"], data.get("separator", ""), data.get("recorded_at", ""),
                   *(data.get(key, "") for key in ("earlier_title", "earlier_summary", "later_title", "later_summary")))


def split_scene(project, scene, offset, title, summary):
    if scene.historical or type(offset) is not int or not 0 < offset < len(scene.text):
        raise ValueError("Split inside a current scene, leaving text on both sides")
    scene.record_revision()
    later = Scene(uuid4(), title, summary, scene.text[offset:], note_color=scene.note_color, metadata=scene.metadata)
    before_comments, after_comments = [], []
    for comment in scene.comments:
        if not comment.detached and comment.start >= offset:
            comment.start -= offset
            comment.end -= offset
            after_comments.append(comment)
        else:
            if not comment.detached and comment.end > offset:
                comment.detach()
            before_comments.append(comment)
    scene.comments, later.comments = before_comments, after_comments
    before, after = [], []
    for item in scene.dialogue:
        if not item.detached and item.start >= offset:
            after.append(replace(item, start=item.start - offset, end=item.end - offset))
        else:
            before.append(item.detach() if not item.detached and item.end > offset else item)
    scene.dialogue, later.dialogue = before, after
    scene.text = scene.text[:offset]
    project.scenes.insert(project.scenes.index(scene) + 1, later)
    for (scene_id, column_id), value in list(project.storyboard_cells.items()):
        if scene_id == scene.id:
            project.set_storyboard_value(later.id, column_id, value)
    project.scene_changes.append(SceneChange(uuid4(), "split", scene.id, later.id, offset,
        recorded_at=datetime.now(timezone.utc).isoformat(), earlier_title=scene.title,
        earlier_summary=scene.summary, later_title=later.title, later_summary=later.summary))
    return later


def join_scenes(project, earlier, later, title, summary, separator):
    current = project.current_scenes()
    if (earlier not in current or later not in current
            or current.index(later) != current.index(earlier) + 1):
        raise ValueError("Join two adjacent current scenes in presentation order")
    if separator not in {"", "\n", "\n\n"}:
        raise ValueError("Choose no separator, one newline, or a blank line")
    earlier.record_revision()
    later.record_revision()
    previous_title, previous_summary = earlier.title, earlier.summary
    offset = len(earlier.text) + len(separator)
    # History of the removed scene keeps its title, metadata, cells and links.
    from copy import deepcopy
    comment_ids = {item.id for item in earlier.comments}
    for comment in deepcopy(later.comments):
        if comment.id in comment_ids:
            comment.id = uuid4()
        if not comment.detached:
            comment.start += offset
            comment.end += offset
        earlier.comments.append(comment)
    dialogue_ids = {item.id for item in earlier.dialogue}
    for item in later.dialogue:
        moved = item if item.detached else replace(item, start=item.start + offset, end=item.end + offset)
        earlier.dialogue.append(replace(moved, id=uuid4()) if item.id in dialogue_ids else moved)
    earlier.text += separator + later.text
    earlier.title, earlier.summary = title, summary
    later.historical = True
    project.scene_changes.append(SceneChange(uuid4(), "join", earlier.id, later.id, offset, separator,
        datetime.now(timezone.utc).isoformat(), previous_title, previous_summary, later.title, later.summary))
    return earlier
