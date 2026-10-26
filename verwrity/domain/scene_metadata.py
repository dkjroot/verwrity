"""Optional author-provided scene context, separate from manuscript prose."""

from dataclasses import asdict, dataclass, fields
from typing import ClassVar, Mapping


@dataclass(frozen=True, slots=True)
class SceneMetadata:
    location: str = ""
    time_period: str = ""
    story_time: str = ""
    pov_character: str = ""
    narrator: str = ""
    narrative_perspective: str = ""
    tense: str = ""
    voice_notes: str = ""
    purpose: str = ""

    LONG_FIELDS: ClassVar[frozenset[str]] = frozenset({"voice_notes", "purpose"})

    def as_dict(self) -> dict[str, str]:
        return {"provenance": "human-authored", **asdict(self)}

    @classmethod
    def from_dict(cls, value: Mapping[str, object]) -> "SceneMetadata":
        if not isinstance(value, dict) or value.get("provenance", "human-authored") != "human-authored":
            raise ValueError("Invalid author-provided scene metadata")
        names = {item.name for item in fields(cls)}
        if set(value) - names - {"provenance"}:
            raise ValueError("Unknown scene metadata field")
        cleaned = {}
        for name in names:
            text = value.get(name, "")
            limit = 2000 if name in cls.LONG_FIELDS else 500
            if not isinstance(text, str) or len(text) > limit:
                raise ValueError(f"Scene metadata {name} must be text up to {limit} characters")
            cleaned[name] = text.replace("\r\n", "\n").replace("\r", "\n").strip()
        return cls(**cleaned)
