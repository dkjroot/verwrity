"""Portable project archive format.

Human-authored source files are kept as ordinary readable files inside the ZIP;
derived indexes can be added later without becoming the only copy of the story.
"""

from __future__ import annotations

import io
import json
import re
import zipfile
import zlib
from uuid import UUID, uuid4

from verwrity.domain.story import (
    ManuscriptComment, Scene, SceneRevision, SceneRevisionComment, StoryboardColumn,
    StoryProject, WikiPage, WikiRevision,
)
from verwrity.domain.dialogue import read_dialogue
from verwrity.domain.scene_operations import SceneChange
from verwrity.domain.scene_metadata import SceneMetadata
from verwrity.domain.project_features import ProjectFeatures
from verwrity.domain.fingal import FingalSource
from verwrity.domain.world import WorldMap, WorldPage, read_record, record_data, validate_world
from verwrity.domain.wiki_provenance import read_annotations


ARCHIVE_VERSION = 10
SUPPORTED_ARCHIVE_VERSIONS = set(range(1, ARCHIVE_VERSION + 1))
MAX_ARCHIVE_BYTES = 25 * 1024 * 1024
MAX_MEMBER_BYTES = 20 * 1024 * 1024
MAX_MEMBER_COUNT = 32
MAX_EXPANDED_BYTES = 64 * 1024 * 1024
SCENE_NOTE_COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")
SPELLING_WORD = re.compile(r"[^\W\d_]+(?:['’\-][^\W\d_]+)*", re.UNICODE)


def safe_filename(title: str) -> str:
    """Return a filesystem-friendly project filename stem."""
    cleaned = re.sub(r"[^A-Za-z0-9._ -]+", "", title).strip(" .")
    return cleaned or "untitled-story"


def export_project(project: StoryProject) -> tuple[str, bytes]:
    """Serialize a project to a named ZIP archive."""
    validate_world(project)
    manifest = {"archive_version": ARCHIVE_VERSION, "title": project.title, "project_id": str(project.project_id)}
    scenes = [
        {
            "id": str(scene.id), "title": scene.title, "summary": scene.summary,
            "text": scene.text, "historical": scene.historical,
            "note_color": scene.note_color,
            "metadata": scene.metadata.as_dict(),
            "dialogue": [item.as_dict() for item in scene.dialogue],
            "comments": [comment.as_dict() for comment in scene.comments],
            "revisions": [revision.as_dict() for revision in scene.revisions],
        }
        for scene in project.scenes
    ]
    wiki_pages = [
        {
            "id": str(page.id), "title": page.title, "body": page.body,
            "tags": list(page.tags),
            "aliases": list(page.aliases),
            **page.provenance_dict(),
            "world": record_data(page.world),
            "revisions": [
                {"id": str(revision.id), "title": revision.title, "body": revision.body,
                 "tags": list(revision.tags), "saved_at": revision.saved_at,
                 "aliases": list(revision.aliases), "purpose": revision.purpose,
                 "annotations": [item.as_dict() for item in revision.annotations], "world": record_data(revision.world)}
                for revision in page.revisions
            ],
        }
        for page in project.wiki_pages
    ]
    storyboard = {
        "columns": [{"id": str(column.id), "title": column.title} for column in project.storyboard_columns],
        "cells": [
            {"scene_id": str(scene_id), "column_id": str(column_id), "value": value}
            for (scene_id, column_id), value in project.storyboard_cells.items()
        ],
    }
    spelling_dictionary = sorted({word.replace("’", "'").casefold() for word in project.spelling_dictionary}, key=str.casefold)
    manuscript = "\n\n".join(f"# {scene.title}\n\n{scene.text}" for scene in project.current_scenes())
    members = {
        "manifest.json": json.dumps(manifest, indent=2) + "\n",
        "project_features.json": json.dumps(project.features.as_dict(), indent=2) + "\n",
        "world_maps.json": json.dumps([record_data(item) for item in project.maps], indent=2) + "\n",
        "fingal_source.json": json.dumps(project.fingal_source.as_dict() if project.fingal_source else None, ensure_ascii=False, indent=2) + "\n",
        "manuscript.txt": manuscript,
        "scenes.json": json.dumps(scenes, indent=2) + "\n",
        "scene_changes.json": json.dumps([item.as_dict() for item in project.scene_changes], indent=2) + "\n",
        "wiki.json": json.dumps(wiki_pages, indent=2) + "\n",
        "storyboard.json": json.dumps(storyboard, indent=2) + "\n",
        "spelling_dictionary.json": json.dumps(spelling_dictionary, ensure_ascii=False, indent=2) + "\n",
        "project_words.json": json.dumps(list(project.project_words), ensure_ascii=False, indent=2) + "\n",
    }
    encoded = {name: value.encode("utf-8") for name, value in members.items()}
    if any(len(value) > MAX_MEMBER_BYTES for value in encoded.values()):
        raise ValueError("Project source or history exceeds the archive member size limit")
    if sum(map(len, encoded.values())) > MAX_EXPANDED_BYTES:
        raise ValueError("Project exceeds the expanded archive size limit")
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, value in encoded.items():
            archive.writestr(name, value)
    data = output.getvalue()
    if len(data) > MAX_ARCHIVE_BYTES:
        raise ValueError("Project exceeds the archive size limit")
    # A successful save must satisfy exactly the same identity/shape contract
    # as an import. Validate before any existing file is replaced.
    import_project(data)
    return f"{safe_filename(project.title)}.verwrity.zip", data


def _objects(value):
    if not isinstance(value, list) or any(not isinstance(item, dict) for item in value):
        raise ValueError("Expected a list of records")
    return value


def _text(item, key, default=""):
    value = item.get(key, default)
    if not isinstance(value, str):
        raise ValueError("Expected text")
    return value


def _flag(item, key):
    value = item.get(key, False)
    if not isinstance(value, bool):
        raise ValueError("Expected a boolean")
    return value


def _strings(item, key):
    value = item.get(key, [])
    if not isinstance(value, list) or any(not isinstance(entry, str) for entry in value):
        raise ValueError("Expected text list")
    return tuple(value)


def _identity(item, seen):
    identity = UUID(_text(item, "id"))
    if identity in seen:
        raise ValueError("Duplicate identity")
    seen.add(identity)
    return identity


def _comments(items, text, revision=False):
    result, seen = [], set()
    for item in _objects(items):
        identity = _identity(item, seen)
        quote, body = _text(item, "quote"), _text(item, "body")
        start, end = item.get("start"), item.get("end")
        detached = _flag(item, "detached")
        if any(value is not None and (not isinstance(value, int) or isinstance(value, bool)) for value in (start, end)):
            raise ValueError("Invalid comment position")
        valid = (isinstance(start, int) and isinstance(end, int)
                 and 0 <= start < end <= len(text) and text[start:end] == quote)
        # Older saves can contain stale or collapsed anchors. Preserve the
        # human comment as detached instead of discarding it or guessing a match.
        detached = detached or not valid
        comment_type = SceneRevisionComment if revision else ManuscriptComment
        result.append(comment_type(
            identity, None if detached else start, None if detached else end, quote, body,
            _flag(item, "resolved"), _flag(item, "added_to_todo"), detached,
            _text(item, "original_quote", quote), _text(item, "prefix"), _text(item, "suffix"),
        ))
    return result


def import_project(data: bytes) -> StoryProject:
    """Load readable sources; reject malformed containers and ambiguous IDs."""
    if len(data) > MAX_ARCHIVE_BYTES:
        raise ValueError("Project archive is too large")
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            members = archive.infolist()
            names = set(archive.namelist())
            if len(members) > MAX_MEMBER_COUNT or len(names) != len(members):
                raise ValueError("Too many or duplicate archive members")
            if any(info.file_size > MAX_MEMBER_BYTES for info in members):
                raise ValueError("Project archive member is too large")
            if sum(info.file_size for info in members) > MAX_EXPANDED_BYTES:
                raise ValueError("Project archive expanded size is too large")
            if not {"manifest.json", "manuscript.txt"}.issubset(names):
                raise ValueError("Missing required source files")
            manifest = json.loads(archive.read("manifest.json"))
            if (not isinstance(manifest, dict) or type(manifest.get("archive_version")) is not int
                    or manifest["archive_version"] not in SUPPORTED_ARCHIVE_VERSIONS):
                raise ValueError("Unsupported project archive version")
            project_id = UUID(_text(manifest, "project_id", None))
            if manifest["archive_version"] >= 6 and "project_features.json" not in names:
                raise ValueError("Missing project features")
            features = ProjectFeatures.from_dict(json.loads(archive.read("project_features.json"))) if "project_features.json" in names else ProjectFeatures()
            if manifest["archive_version"] >= 7 and "world_maps.json" not in names:
                raise ValueError("Missing world maps")
            maps = [read_record(WorldMap, item) for item in _objects(json.loads(archive.read("world_maps.json")))] if "world_maps.json" in names else []
            if manifest["archive_version"] >= 8 and "fingal_source.json" not in names:
                raise ValueError("Missing Fingal source record")
            source_data = json.loads(archive.read("fingal_source.json")) if "fingal_source.json" in names else None
            fingal_source = FingalSource.from_dict(source_data) if source_data is not None else None
            scenes_data = _objects(json.loads(archive.read("scenes.json"))) if "scenes.json" in names else []
            wiki_data = _objects(json.loads(archive.read("wiki.json"))) if "wiki.json" in names else []
            storyboard = json.loads(archive.read("storyboard.json")) if "storyboard.json" in names else {}
            words = json.loads(archive.read("spelling_dictionary.json")) if "spelling_dictionary.json" in names else []
            if not isinstance(storyboard, dict):
                raise ValueError("Invalid storyboard structure")
            if (not isinstance(words, list) or len(words) > 10_000
                    or any(not isinstance(word, str) or len(word) > 80 or not SPELLING_WORD.fullmatch(word) for word in words)):
                raise ValueError("Invalid spelling dictionary")
            scenes, scene_ids = [], set()
            for item in scenes_data:
                identity = _identity(item, scene_ids)
                text = _text(item, "text")
                revisions, revision_ids, previous = [], set(), 0
                for record in _objects(item.get("revisions", [])):
                    revision_id = _identity(record, revision_ids)
                    number = record.get("number")
                    if type(number) is not int or number <= previous:
                        raise ValueError("Invalid scene revision number")
                    previous = number
                    revision_text = _text(record, "text")
                    revisions.append(SceneRevision(revision_id, number, revision_text,
                        _text(record, "recorded_at"), tuple(_comments(record.get("comments", []), revision_text, True)),
                        tuple(read_dialogue(record.get("dialogue", []), revision_text))))
                color = item.get("note_color")
                if color is not None and (not isinstance(color, str) or not SCENE_NOTE_COLOR.fullmatch(color)):
                    raise ValueError("Invalid scene colour")
                scenes.append(Scene(identity, _text(item, "title", None), _text(item, "summary"), text,
                    _flag(item, "historical"), color.lower() if color else None,
                    _comments(item.get("comments", []), text), revisions,
                    SceneMetadata.from_dict(item.get("metadata", {})), read_dialogue(item.get("dialogue", []), text)))
            if "scenes.json" not in names:
                legacy = archive.read("manuscript.txt").decode("utf-8")
                if legacy:
                    scene = Scene(uuid4(), "Imported manuscript", text=legacy)
                    scenes.append(scene)
                    scene_ids.add(scene.id)
            pages, page_ids = [], set()
            for item in wiki_data:
                identity = _identity(item, page_ids)
                revisions, revision_ids = [], set()
                for record in _objects(item.get("revisions", [])):
                    revisions.append(WikiRevision(_identity(record, revision_ids), _text(record, "title", None),
                        _text(record, "body"), _strings(record, "tags"), _text(record, "saved_at"), _strings(record, "aliases"),
                        _text(record, "purpose"), read_annotations(record.get("annotations", []), _text(record, "body")),
                        read_record(WorldPage, record.get("world", {}))))
                pages.append(WikiPage(identity, _text(item, "title", None), _text(item, "body"),
                    _strings(item, "tags"), tuple(revisions), _strings(item, "aliases"),
                    _text(item, "purpose"), read_annotations(item.get("annotations", []), _text(item, "body")),
                    read_record(WorldPage, item.get("world", {}))))
            columns, column_ids = [], set()
            for item in _objects(storyboard.get("columns", [])):
                columns.append(StoryboardColumn(_identity(item, column_ids), _text(item, "title")))
            cells = {}
            for item in _objects(storyboard.get("cells", [])):
                key = (UUID(_text(item, "scene_id")), UUID(_text(item, "column_id")))
                if key[0] not in scene_ids or key[1] not in column_ids or key in cells:
                    raise ValueError("Invalid storyboard cell reference")
                cells[key] = _text(item, "value")
            project = StoryProject(_text(manifest, "title", None), project_id, scenes, pages, columns, cells,
                {word.replace("’", "'").casefold() for word in words}, features, maps, fingal_source)
            from verwrity.domain.project_words import checked_project_words
            if manifest["archive_version"] >= 10 and "project_words.json" not in names:
                raise ValueError("Missing project words")
            project.project_words = checked_project_words(json.loads(archive.read("project_words.json"))) if "project_words.json" in names else ()
            if manifest["archive_version"] >= 9 and "scene_changes.json" not in names:
                raise ValueError("Missing scene change history")
            project.scene_changes = [SceneChange.from_dict(item) for item in _objects(json.loads(archive.read("scene_changes.json")))] if "scene_changes.json" in names else []
            if len({item.id for item in project.scene_changes}) != len(project.scene_changes):
                raise ValueError("Duplicate scene change identity")
            for scene in scenes:
                for records in [scene.dialogue, *(revision.dialogue for revision in scene.revisions)]:
                    if any(item.speaker_id is not None and item.speaker_id not in page_ids for item in records):
                        raise ValueError("Missing dialogue speaker wiki page")
            validate_world(project)
            return project
    except (KeyError, ValueError, TypeError, UnicodeDecodeError, zipfile.BadZipFile,
            RuntimeError, NotImplementedError, RecursionError, OverflowError, EOFError, zlib.error) as exc:
        raise ValueError("Invalid Verwrity project archive") from exc
