"""Author-confirmed speaker links, separate from canonical manuscript text."""
from dataclasses import asdict, dataclass, replace
from uuid import UUID
from hashlib import sha256


@dataclass(frozen=True, slots=True)
class DialogueAttribution:
    id: UUID
    speaker_id: UUID | None
    start: int | None
    end: int | None
    quote: str
    original_quote: str = ""
    detached: bool = False
    origin: str = "human-authored"
    run_id: str = ""

    def as_dict(self):
        return {**asdict(self), "id": str(self.id),
                "speaker_id": str(self.speaker_id) if self.speaker_id else None}

    def detach(self):
        return replace(self, start=None, end=None, detached=True)


def read_dialogue(items, text):
    if not isinstance(items, list) or len(items) > 10000:
        raise ValueError("Invalid dialogue records")
    result, seen = [], set()
    for item in items:
        if not isinstance(item, dict):
            raise ValueError("Invalid dialogue record")
        if not isinstance(item.get("id"), str) or (item.get("speaker_id") is not None and not isinstance(item["speaker_id"], str)):
            raise ValueError("Invalid dialogue identity")
        identity = UUID(item["id"])
        if identity in seen:
            raise ValueError("Duplicate dialogue identity")
        seen.add(identity)
        start, end, quote = item.get("start"), item.get("end"), item.get("quote")
        if (not isinstance(quote, str) or not quote or
                any(value is not None and type(value) is not int for value in (start, end))):
            raise ValueError("Invalid dialogue anchor")
        origin = item.get("origin", "human-authored")
        original, run = item.get("original_quote", quote), item.get("run_id", "")
        if (origin not in {"human-authored", "ai-suggested-author-confirmed"}
                or not isinstance(original, str) or not isinstance(run, str)
                or type(item.get("detached", False)) is not bool):
            raise ValueError("Invalid dialogue provenance")
        detached = item.get("detached", False) or not (
            type(start) is int and type(end) is int and 0 <= start < end <= len(text) and text[start:end] == quote)
        result.append(DialogueAttribution(identity,
            UUID(item["speaker_id"]) if item.get("speaker_id") else None,
            None if detached else start, None if detached else end, quote, original, detached, origin, run))
    return result


def update_dialogue_ranges(scene, submitted=()):
    """Only editor-mapped exact anchors may move; never search repeated quotes."""
    by_id = {item.get("id"): item for item in submitted if isinstance(item, dict)}
    result = []
    for record in scene.dialogue:
        item = by_id.get(str(record.id), {})
        start, end = item.get("start", record.start), item.get("end", record.end)
        valid = (type(start) is int and type(end) is int and 0 <= start < end <= len(scene.text)
                 and scene.text[start:end] == record.quote)
        # Undo may restore a previously known exact anchor during this editor visit.
        if item.get("detached") is True or not valid or (record.detached and item.get("restored") is not True):
            result.append(record.detach())
        else:
            result.append(replace(record, start=start, end=end, detached=False))
    scene.dialogue = result


def dialogue_rows(project, speaker_id):
    rows = []
    for number, scene in enumerate(project.current_scenes(), 1):
        for item in sorted(scene.dialogue, key=lambda item: (item.start is None, item.start or 0)):
            if item.speaker_id != speaker_id:
                continue
            live = (not item.detached and type(item.start) is int and type(item.end) is int
                    and scene.text[item.start:item.end] == item.quote)
            display = item.quote
            if live:
                start, end = item.start, item.end
                # Include only punctuation actually present beside the anchor.
                while start > 0 and scene.text[start - 1] in "\"'“‘«":
                    start -= 1
                while end < len(scene.text) and scene.text[end] in "\"'”’».,!?;:":
                    end += 1
                display = scene.text[start:end]
            rows.append({**item.as_dict(), "display_quote": display, "scene_id": str(scene.id), "scene_title": scene.title,
                         "scene_number": number, "scene_hash": sha256(scene.text.encode()).hexdigest(), "summary": scene.summary, "metadata": scene.metadata.as_dict(),
                         "context": scene.text[max(0, item.start - 100):item.end + 100] if live else "",
                         "detached": not live})
    return rows
