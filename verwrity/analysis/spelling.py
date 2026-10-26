"""Server-side spelling analysis.

The checker produces annotations alongside the manuscript.  It never edits the
text it analyses; the browser is responsible only for rendering the returned
annotation ranges.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from difflib import get_close_matches
from importlib.resources import files
import re
from typing import Iterable
from uuid import UUID, uuid4


WORD_RE = re.compile(r"[^\W\d_]+(?:['’‘ʼ＇\-‐‑][^\W\d_]+)*", re.UNICODE)


def normalize_word(word):
    return word.translate(str.maketrans({"’": "'", "‘": "'", "ʼ": "'", "＇": "'", "‐": "-", "‑": "-"})).casefold()


@dataclass(frozen=True, slots=True)
class SpellingAnnotation:
    """A view-only spelling finding, expressed as offsets in source text."""

    id: UUID
    scene_id: UUID
    start: int
    end: int
    word: str
    suggestions: tuple[str, ...]

    def as_dict(self) -> dict[str, object]:
        value = asdict(self)
        value["id"] = str(self.id)
        value["scene_id"] = str(self.scene_id)
        value["suggestions"] = list(self.suggestions)
        return value


@dataclass(frozen=True, slots=True)
class SpellCheckResult:
    """One reproducible analysis run over one scene's submitted text."""

    run_id: UUID
    scene_id: UUID
    created_at: datetime
    annotations: tuple[SpellingAnnotation, ...]

    def as_dict(self) -> dict[str, object]:
        return {
            "run_id": str(self.run_id),
            "scene_id": str(self.scene_id),
            "created_at": self.created_at.isoformat(),
            "annotations": [annotation.as_dict() for annotation in self.annotations],
        }


class SpellChecker:
    """Analyze text with a bundled, open-source English spelling list."""

    def __init__(self, words: Iterable[str] | None = None) -> None:
        self._words = frozenset(normalize_word(word.strip()) for word in (words or self._load_words()) if word.strip())
        self._suggestion_cache: dict[str, tuple[str, ...]] = {}

    @staticmethod
    def _load_words() -> Iterable[str]:
        path = files("verwrity.analysis").joinpath("data/english_words.txt")
        return path.read_text(encoding="utf-8").splitlines()

    def analyze(self, scene_id: UUID, text: str, dictionary_words: Iterable[str] = ()) -> SpellCheckResult:
        words = frozenset(normalize_word(word) for word in dictionary_words if word)
        dictionary = self._words | words if words else self._words
        annotations = tuple(
            SpellingAnnotation(
                id=uuid4(),
                scene_id=scene_id,
                start=match.start(),
                end=match.end(),
                word=match.group(),
                suggestions=self.suggestions_for(match.group(), extra_words=words),
            )
            for match in WORD_RE.finditer(text)
            if not self._is_correct(match.group(), dictionary)
        )
        return SpellCheckResult(uuid4(), scene_id, datetime.now(timezone.utc), annotations)

    def is_correct(self, word: str, extra_words: Iterable[str] = ()) -> bool:
        custom = frozenset(normalize_word(value) for value in extra_words)
        dictionary = self._words | custom if custom else self._words
        return self._is_correct(word, dictionary)

    @classmethod
    def _is_correct(cls, word: str, dictionary: frozenset[str]) -> bool:
        normalized = normalize_word(word)
        if normalized in dictionary:
            return True
        # Possessive forms remain valid for dictionary words and inflections,
        # including plural possessives such as "writers'".
        if normalized.endswith("'s") and cls._is_correct(normalized[:-2], dictionary):
            return True
        if normalized.endswith("s'") and cls._known_form(normalized[:-1], dictionary):
            return True
        if "-" in normalized:
            return all(part and cls._is_correct(part, dictionary) for part in normalized.split("-"))
        return cls._known_form(normalized, dictionary)

    @staticmethod
    def _known_form(word: str, dictionary: frozenset[str]) -> bool:
        """Check common English inflections by recovering a known base form."""
        if word in dictionary:
            return True
        candidates: set[str] = set()
        if word.endswith("ies") and len(word) > 4:
            candidates.add(word[:-3] + "y")
        if word.endswith("ves") and len(word) > 4:
            candidates.update((word[:-3] + "f", word[:-3] + "fe"))
        if word.endswith(("ches", "shes", "sses", "xes", "zes", "oes")):
            candidates.add(word[:-2])
        if word.endswith("ses") and len(word) > 4:
            candidates.update((word[:-2], word[:-2] + "e"))
        if word.endswith("s") and len(word) > 3:
            candidates.add(word[:-1])
        if word.endswith("ied") and len(word) > 4:
            candidates.add(word[:-3] + "y")
        if word.endswith("ed") and len(word) > 4:
            stem = word[:-2]
            candidates.update((stem, stem + "e"))
            if len(stem) > 2 and stem[-1] == stem[-2]:
                candidates.add(stem[:-1])
        if word.endswith("ing") and len(word) > 5:
            stem = word[:-3]
            candidates.update((stem, stem + "e"))
            if len(stem) > 2 and stem[-1] == stem[-2]:
                candidates.add(stem[:-1])
        for suffix in ("er", "est"):
            if word.endswith(suffix) and len(word) > len(suffix) + 2:
                stem = word[:-len(suffix)]
                candidates.update((stem, stem + "e", stem + "y"))
                if len(stem) > 2 and stem[-1] == stem[-2]:
                    candidates.add(stem[:-1])
        return any(candidate in dictionary for candidate in candidates)

    def suggestions_for(self, word: str, limit: int = 3, extra_words: Iterable[str] = ()) -> tuple[str, ...]:
        normalized = normalize_word(word)
        custom = frozenset(normalize_word(value) for value in extra_words)
        cached = self._suggestion_cache.get(normalized) if not custom else None
        if cached is not None:
            return cached
        dictionary = self._words | custom
        candidates = (candidate for candidate in dictionary if abs(len(candidate) - len(normalized)) <= 2)
        suggestions = tuple(get_close_matches(normalized, candidates, n=limit, cutoff=0.62))
        if not custom:
            self._suggestion_cache[normalized] = suggestions
        return suggestions
