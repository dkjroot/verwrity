"""World authoring projections and concrete record forms."""

from dataclasses import fields, is_dataclass
from hashlib import sha256
import json
from types import UnionType
from typing import Literal, get_args, get_origin, get_type_hints
from uuid import UUID

from verwrity.analysis.wiki import page_hash
from verwrity.domain.world import record_data, SLOTS, DIRECTIONS, SKILLS


def world_hash(project):
    data = {"source": project.fingal_source.digest if project.fingal_source else None,
        "maps": [record_data(item) for item in project.maps], "pages": [
        {"id": str(page.id), "title": page.title, "world": record_data(page.world)} for page in project.wiki_pages]}
    return sha256(json.dumps(data, sort_keys=True).encode()).hexdigest()


def world_state(project):
    return {"project_id": str(project.project_id), "revision": world_hash(project),
        "capabilities": {"map": project.features.map_enabled, "character": project.features.characters_enabled},
        "maps": [record_data(item) for item in project.maps],
        "pages": [{"id": str(page.id), "title": page.title, "page_hash": page_hash(page),
                   "world": record_data(page.world)} for page in project.wiki_pages]}


LABELS = {"character_id": "Fingal character ID", "location_id": "Fingal location ID",
    "home_location": "Starting cell (home location)", "map_id": "Map", "target_page_id": "Destination",
    "character_page_id": "Character", "description": "Game description", "backstory": "Private backstory",
    "money": "Starting money (legacy units)", "public_role": "Public local role",
    "recovery_authority": "Can arrange recovery of belongings", "id": "ID", "x": "East / west (X)",
    "y": "South / north (Y)", "extra": "Additional location facts"}


def form_fields(record, project):
    """Describe the existing typed fields, without embedding raw JSON editors."""
    result = []
    hints = get_type_hints(type(record))
    for item in fields(record):
        hint, value = hints[item.name], getattr(record, item.name)
        optional = get_origin(hint) is UnionType and type(None) in get_args(hint)
        if optional:
            hint = next(arg for arg in get_args(hint) if arg is not type(None))
        row = {"name": item.name, "label": LABELS.get(item.name, item.name.replace("_", " ").capitalize()),
               "value": str(value) if isinstance(value, UUID) else value, "optional": optional, **item.metadata}
        origin, args = get_origin(hint), get_args(hint)
        if is_dataclass(hint):
            row.update(type="object", fields=form_fields(value or hint(), project), enabled=value is not None)
        elif origin is tuple and is_dataclass(args[0]):
            row.update(type="records", rows=[form_fields(entry, project) for entry in value], blank=form_fields(args[0](), project))
        elif origin is tuple:
            row.update(type="list", value="\n".join(value))
            if item.name == "skills":
                row["help"] = "One per line: " + ", ".join(SKILLS)
            else:
                row["help"] = "Put each value on its own line. For items, use the ID from the item's definition."
        elif hint is UUID:
            choices = [(str(p.id), p.title) for p in project.wiki_pages if
                (p.world.character if item.name in {"character_page_id", "rightful_owner", "culprit"} else p.world.location)]
            if item.name == "map_id":
                choices = [(str(m.id), m.title) for m in project.maps]
            row.update(type="reference", choices=choices)
        elif origin is Literal:
            row.update(type="choice", choices=[(v, v.replace("_", " ").capitalize()) for v in args])
        elif item.name == "slot":
            row.update(type="choice", choices=([("", "Not wearable")] if not item.metadata.get("required") else []) + [(v, v.replace("_", " ").capitalize()) for v in SLOTS])
        elif item.name == "direction":
            row.update(type="choice", choices=[(v, v.replace("_", " ").capitalize()) for v in DIRECTIONS])
        else:
            numeric = hint in (int, float) or (origin is UnionType and set(args) <= {int, float})
            row.update(type="boolean" if hint is bool else "number" if numeric else "text", step="any" if hint is not int else "1")
        result.append(row)
    return result
