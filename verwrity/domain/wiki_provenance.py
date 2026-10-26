"""Durable wiki authorship and observations, independent of UI/providers."""

from dataclasses import dataclass, replace
from difflib import SequenceMatcher
from datetime import datetime, timezone
import re
from uuid import UUID, uuid5


@dataclass(frozen=True, slots=True)
class WikiEvidence:
    scene_id: UUID
    quote: str

    def as_dict(self):
        return {"scene_id": str(self.scene_id), "quote": self.quote}


@dataclass(frozen=True, slots=True)
class WikiAnnotation:
    id: UUID
    kind: str  # ai_text or suggestion; unmarked text is human-authored
    start: int
    end: int
    quote: str
    run_id: UUID
    source_hash: str
    provider: str
    model: str
    created_at: str
    evidence: tuple[WikiEvidence, ...] = ()
    explanation: str = ""
    status: str = "open"
    analysis_version: str = "wiki-v1"
    origin: str = "ai_generated"  # Update permission is separate from original authorship.
    replacement_text: str | None = None  # Exact replacement awaiting author acceptance.

    def as_dict(self):
        return {"id": str(self.id), "kind": self.kind, "start": self.start,
                "end": self.end, "quote": self.quote, "run_id": str(self.run_id),
                "source_hash": self.source_hash, "provider": self.provider,
                "model": self.model, "created_at": self.created_at,
                "evidence": [item.as_dict() for item in self.evidence],
                "explanation": self.explanation, "status": self.status,
                "analysis_version": self.analysis_version, "origin": self.origin,
                "replacement_text": self.replacement_text}


def read_annotations(raw, body: str) -> tuple[WikiAnnotation, ...]:
    """Reject corrupt provenance rather than silently promote AI text to human."""
    if not isinstance(raw, list) or len(raw) > 1000:
        raise ValueError("Invalid wiki provenance")
    result, seen, ai_ranges = [], set(), []
    for item in raw:
        if not isinstance(item, dict):
            raise ValueError("Invalid wiki annotation")
        strings = ("kind", "quote", "source_hash", "provider", "model", "created_at", "explanation", "status", "analysis_version")
        if any(not isinstance(item.get(key, ""), str) for key in strings):
            raise ValueError("Invalid wiki annotation text")
        start, end = item.get("start"), item.get("end")
        if (type(start) is not int or type(end) is not int or not 0 <= start < end <= len(body)
                or body[start:end] != item.get("quote") or item.get("kind") not in {"ai_text", "suggestion"}
                or item.get("status", "open") not in {"open", "dismissed"}):
            raise ValueError("Invalid wiki annotation range")
        identity = UUID(item["id"])
        if identity in seen:
            raise ValueError("Duplicate wiki annotation identity")
        seen.add(identity)
        origin = item.get("origin", "ai_generated")
        if not isinstance(origin, str) or origin not in {"ai_generated", "human_delegated"} or (origin == "human_delegated" and item["kind"] != "ai_text"):
            raise ValueError("Invalid wiki authorship origin")
        replacement_text = item.get("replacement_text")
        if replacement_text is not None and (item["kind"] != "suggestion"
                or not isinstance(replacement_text, str) or not replacement_text.strip()
                or len(replacement_text) > 100_000):
            raise ValueError("Invalid wiki replacement suggestion")
        raw_evidence = item.get("evidence", [])
        if (not isinstance(raw_evidence, list) or not (0 if origin == "human_delegated" or item.get("analysis_version") == "wiki-instruct-v1" else 1) <= len(raw_evidence) <= 8
                or any(not isinstance(entry, dict) or not isinstance(entry.get("quote"), str)
                       or not entry["quote"].strip() for entry in raw_evidence)):
            raise ValueError("Invalid wiki evidence")
        evidence = tuple(WikiEvidence(UUID(entry["scene_id"]), entry["quote"]) for entry in raw_evidence)
        annotation = WikiAnnotation(identity, item["kind"], start, end, item["quote"], UUID(item["run_id"]),
            item["source_hash"], item["provider"], item["model"], item["created_at"], evidence,
            item.get("explanation", ""), item.get("status", "open"), item.get("analysis_version", "wiki-v1"), origin, replacement_text)
        if origin == "human_delegated" and (evidence or annotation.provider or annotation.model or annotation.source_hash):
            raise ValueError("Human delegation cannot claim model generation or manuscript evidence")
        if annotation.kind == "ai_text":
            if any(start < right and end > left for left, right in ai_ranges):
                raise ValueError("Overlapping AI authorship")
            ai_ranges.append((start, end))
        result.append(annotation)
    if any(a.kind == "suggestion" and any(a.start < end and a.end > start for start, end in ai_ranges) for a in result):
        raise ValueError("Review suggestions must refer to human text")
    return tuple(result)


_BLOCK_LINE = re.compile(r"^\s*(?:#{1,3}\s|[-*]\s|\d+\.\s|>|---+$)")


def wiki_blocks(body: str) -> list[tuple[int, int]]:
    """Plain paragraphs, plus independently editable headings/list/quote lines.

    Separators are not knowledge: inserting a paragraph into blank space must
    not transfer ownership of either neighbouring paragraph.
    """
    blocks, paragraph, offset = [], None, 0
    for line in body.splitlines(keepends=True):
        content = line.rstrip("\r\n")
        end = offset + len(content)
        if not content.strip() or _BLOCK_LINE.match(content):
            if paragraph is not None:
                blocks.append(paragraph)
                paragraph = None
            if content.strip():
                blocks.append((offset, end))
        else:
            paragraph = (paragraph[0] if paragraph else offset, end)
        offset += len(line)
    if paragraph is not None:
        blocks.append(paragraph)
    return blocks


def split_ai_annotations(body: str, annotations) -> tuple[WikiAnnotation, ...]:
    """Upgrade old multi-paragraph AI ranges without changing any wiki text.

    Deterministic child IDs make the same archived page/revision normalize the
    same way on every read. The first block retains its original identity.
    """
    blocks, result = wiki_blocks(body), []
    for annotation in annotations:
        if annotation.kind != "ai_text":
            result.append(annotation)
            continue
        parts = [(max(start, annotation.start), min(end, annotation.end)) for start, end in blocks
                 if start < annotation.end and end > annotation.start]
        for index, (start, end) in enumerate(parts):
            if not body[start:end].strip():
                continue
            identity = annotation.id if index == 0 else uuid5(annotation.id, f"wiki-block-{annotation.run_id}-{index}")
            result.append(replace(annotation, id=identity, start=start, end=end, quote=body[start:end]))
    return tuple(result)


def _human_edit(body, annotations, start, end, text):
    updated = body[:start] + text + body[end:]
    old_blocks, new_blocks = wiki_blocks(body), set(wiki_blocks(updated))
    delta, result = len(text) - (end - start), []
    for annotation in annotations:
        if annotation.kind != "ai_text":
            continue
        block = next(((left, right) for left, right in old_blocks
                      if left <= annotation.start and annotation.end <= right), None)
        if block is None:
            continue
        left, right = block
        if (start < right and end > left) or (start == end and left < start < right):
            continue  # Touching any part of this paragraph adopts this paragraph only.
        shift = delta if end <= left else 0
        if (left + shift, right + shift) not in new_blocks:
            continue  # A merge or inline insertion adopts the newly joined paragraph.
        result.append(replace(annotation, start=annotation.start + shift, end=annotation.end + shift))
    return updated, tuple(result)


def _normalize_newlines(body, annotations):
    normalized = lambda text: text.replace("\r\n", "\n").replace("\r", "\n")
    return normalized(body), tuple(replace(a, start=len(normalized(body[:a.start])),
        end=len(normalized(body[:a.end])), quote=normalized(a.quote)) for a in annotations)


def set_ai_maintenance(body, annotations, start, end, enabled, identity):
    """Author permission for exactly the selected text; never invent AI authorship."""
    if (type(start) is not int or type(end) is not int or not 0 <= start < end <= len(body)
            or type(enabled) is not bool):
        raise ValueError("Select wiki text to change its AI maintenance permission.")
    if not isinstance(identity, str):
        raise ValueError("Invalid wiki maintenance identity")
    identity = UUID(identity)
    if any(a.id == identity for a in annotations):
        raise ValueError("Duplicate wiki maintenance identity")
    result = []
    for a in annotations:
        if a.start >= end or a.end <= start:
            result.append(a)
        elif a.kind == "ai_text":
            # Preserve the origin/evidence of already AI-owned selected text.
            intervals = [(a.start, min(start, a.end)), (max(end, a.start), a.end)]
            if enabled:
                intervals.append((max(start, a.start), min(end, a.end)))
            for index, (left, right) in enumerate(intervals):
                if left < right:
                    child = a.id if not any(r.id == a.id for r in result) else uuid5(identity, f"preserve-{a.id}-{index}")
                    result.append(replace(a, id=child, start=left, end=right, quote=body[left:right]))
        # Overlapping review findings no longer refer to wholly human text.
    if enabled:
        ranges = [(max(left, start), min(right, end)) for left, right in wiki_blocks(body)
                  if left < end and right > start]
        created = datetime.now(timezone.utc).isoformat(timespec="seconds")
        for left, right in ranges:
            owned = sorted((max(a.start, left), min(a.end, right)) for a in result
                           if a.kind == "ai_text" and a.start < right and a.end > left)
            cursor = left
            for boundary, after in owned + [(right, right)]:
                if cursor < boundary and body[cursor:boundary].strip():
                    result.append(WikiAnnotation(uuid5(identity, f"delegate-{cursor}-{boundary}"), "ai_text",
                        cursor, boundary, body[cursor:boundary], identity, "", "", "", created,
                        origin="human_delegated"))
                cursor = max(cursor, after)
    result = split_ai_annotations(body, result)
    if len(result) > 1000:
        raise ValueError("This page has reached the 1,000 annotation limit.")
    return result


def human_edit_annotations(old: str, new: str, annotations, edits=None) -> tuple[WikiAnnotation, ...]:
    """Apply author edits using their actual positions, never a quote search.

    Native editor edit positions distinguish repeated AI/human paragraphs. The
    fallback supports older clients and explicit whole-body API saves by matching
    complete paragraphs, rather than comparing one large model-response range.
    """
    annotations = split_ai_annotations(old, annotations)
    if edits is not None:
        if not isinstance(edits, list) or len(edits) > 100_000:
            raise ValueError("Invalid wiki edit history. Keep your text and reopen the page.")
        body = old
        # Older HTML attributes normalized CRLF before JavaScript saw the source.
        # Those tabs recorded LF positions without an explicit normalization step.
        if "\r" in old and "\r" not in new and (not edits or edits[0] != {"kind": "normalize_newlines"}):
            body, annotations = _normalize_newlines(body, annotations)
        for edit in edits:
            if isinstance(edit, dict) and edit == {"kind": "normalize_newlines"}:
                body, annotations = _normalize_newlines(body, annotations)
                continue
            if isinstance(edit, dict) and edit.get("kind") == "ai_maintenance":
                annotations = set_ai_maintenance(body, annotations, edit.get("start"), edit.get("end"),
                    edit.get("enabled"), edit.get("id"))
                continue
            if (not isinstance(edit, dict) or type(edit.get("start")) is not int
                    or type(edit.get("end")) is not int or not isinstance(edit.get("text"), str)
                    or not 0 <= edit["start"] <= edit["end"] <= len(body)):
                raise ValueError("Invalid wiki edit position.")
            body, annotations = _human_edit(body, annotations, edit["start"], edit["end"], edit["text"])
            if len(body) > 100_000:
                raise ValueError("Wiki page content exceeds 100,000 characters.")
        if body != new:
            raise ValueError("The editor couldn't safely preserve this page's human/AI update permissions, so the page was not saved. "
                "Your text is still in the edit box. Copy it somewhere safe, reload this page, and paste your edits back. "
                "Pasted text is protected; select any passages you want to hand back to AI maintenance.")
        return annotations
    if "\r" in old:
        old, annotations = _normalize_newlines(old, annotations)
        new = new.replace("\r\n", "\n").replace("\r", "\n")
    if old == new:
        return annotations
    if not any(a.kind == "ai_text" for a in annotations):
        return ()
    old_blocks, new_blocks = wiki_blocks(old), wiki_blocks(new)
    matches = SequenceMatcher(None, [old[a:b] for a, b in old_blocks],
                              [new[a:b] for a, b in new_blocks], autojunk=False).get_matching_blocks()
    mapped = {old_blocks[match.a + i]: new_blocks[match.b + i] for match in matches for i in range(match.size)}
    result = []
    for a in annotations:
        if a.kind != "ai_text":
            continue
        block = next((b for b in mapped if b[0] <= a.start and a.end <= b[1]), None)
        if block:
            shift = mapped[block][0] - block[0]
            result.append(replace(a, start=a.start + shift, end=a.end + shift))
    return tuple(result)
