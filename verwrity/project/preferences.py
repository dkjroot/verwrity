"""Small, user-scoped application preferences stored outside project archives."""

from __future__ import annotations

import json
import re
from pathlib import Path
from tempfile import NamedTemporaryFile


DEFAULT_PREFERENCES = {
    "manuscript": {
        "font_family": "sans-serif",
        "font_size": 16,
        "text_color": "auto",
        "background_color": "auto",
    },
    "spelling": {"enabled": False, "style": "squiggly", "color": "#ef4444"},
    "wiki_links": {"enabled": False, "style": "underline", "color": "#4f8fba"},
    "comments": {"enabled": False, "style": "underline", "color": "#8b72c7"},
    "dialogue": {"enabled": False, "style": "underline", "color": "#0d9488"},
}
ANNOTATION_STYLES = {"underline", "squiggly", "double", "highlight"}
MANUSCRIPT_FONTS = {"sans-serif", "serif"}
MANUSCRIPT_FONT_SIZES = {14, 16, 18, 20, 22}
PREFERENCES_VERSION = 1


def _valid_color(value: object) -> bool:
    return isinstance(value, str) and re.fullmatch(r"#[0-9a-fA-F]{6}", value) is not None


class UserPreferences:
    """Persist UI preferences per local user, separately from story projects."""

    def __init__(self, root: Path | str = "user_files") -> None:
        self.root = Path(root)

    def _path(self, user_id: str) -> Path:
        if not user_id or Path(user_id).name != user_id or user_id in {".", ".."}:
            raise ValueError("Invalid user identifier")
        return self.root / user_id / "preferences.json"

    def _dictionary_path(self, user_id: str) -> Path:
        self._path(user_id)  # Apply the same path validation as preferences.
        return self.root / user_id / "spelling_dictionary.json"

    def spelling_dictionary(self, user_id: str) -> list[str]:
        """Return the user's global words, stored separately from projects."""
        try:
            values = json.loads(self._dictionary_path(user_id).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return []
        if not isinstance(values, list):
            return []
        return sorted({word.casefold() for word in values if isinstance(word, str)}, key=str.casefold)

    def update_spelling_dictionary(self, user_id: str, word: str, *, remove: bool = False) -> list[str]:
        """Add or remove one already-validated global dictionary word atomically."""
        path = self._dictionary_path(user_id)
        words = set(self.spelling_dictionary(user_id))
        key = word.casefold()
        if remove:
            words.discard(key)
        else:
            words.add(key)
        return self.replace_spelling_dictionary(user_id, words)

    def replace_spelling_dictionary(self, user_id: str, words) -> list[str]:
        """Publish an already-validated user word list atomically."""
        path = self._dictionary_path(user_id)
        words = {word.casefold() for word in words}
        path.parent.mkdir(parents=True, exist_ok=True)
        with NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, prefix=".spelling-dictionary-", delete=False) as temporary:
            json.dump(sorted(words, key=str.casefold), temporary, ensure_ascii=False, indent=2)
            temporary.write("\n")
            temporary.flush()
            temporary_path = Path(temporary.name)
        temporary_path.replace(path)
        return sorted(words, key=str.casefold)

    def load(self, user_id: str) -> dict[str, dict[str, object]]:
        result = json.loads(json.dumps(DEFAULT_PREFERENCES))
        path = self._path(user_id)
        try:
            saved = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return result
        if not isinstance(saved, dict):
            return result
        has_explicit_enabled_settings = saved.get("version") == PREFERENCES_VERSION
        for feature in result:
            value = saved.get(feature)
            if not isinstance(value, dict):
                continue
            if feature == "manuscript":
                if value.get("font_family") in MANUSCRIPT_FONTS:
                    result[feature]["font_family"] = value["font_family"]
                if value.get("font_size") in MANUSCRIPT_FONT_SIZES:
                    result[feature]["font_size"] = value["font_size"]
                for key in ("text_color", "background_color"):
                    if value.get(key) == "auto":
                        result[feature][key] = "auto"
                    elif _valid_color(value.get(key)):
                        result[feature][key] = value[key].lower()
                continue
            # Older preference files inherited enabled-by-default behavior. Treat
            # those values as defaults; the current interface starts decorations off.
            if has_explicit_enabled_settings and isinstance(value.get("enabled"), bool):
                result[feature]["enabled"] = value["enabled"]
            if value.get("style") in ANNOTATION_STYLES:
                result[feature]["style"] = value["style"]
            if _valid_color(value.get("color")):
                result[feature]["color"] = value["color"].lower()
        return result

    def update(self, user_id: str, feature: str, values: dict[str, object]) -> dict[str, object]:
        if feature not in DEFAULT_PREFERENCES:
            raise ValueError("Unknown user preference")
        if not isinstance(values, dict):
            raise ValueError("Invalid annotation preference")
        updated = self.load(user_id)
        current = updated[feature]
        if feature == "manuscript":
            if "font_family" in values:
                if not isinstance(values["font_family"], str) or values["font_family"] not in MANUSCRIPT_FONTS:
                    raise ValueError("Invalid manuscript font family")
                current["font_family"] = values["font_family"]
            if "font_size" in values:
                if isinstance(values["font_size"], bool) or not isinstance(values["font_size"], int) or values["font_size"] not in MANUSCRIPT_FONT_SIZES:
                    raise ValueError("Invalid manuscript font size")
                current["font_size"] = values["font_size"]
            for key in ("text_color", "background_color"):
                if key in values:
                    if not _valid_color(values[key]):
                        raise ValueError(f"Invalid manuscript {key.replace('_', ' ')}")
                    current[key] = values[key].lower()
        else:
            if "enabled" in values and isinstance(values["enabled"], bool):
                current["enabled"] = values["enabled"]
            if "style" in values:
                if not isinstance(values["style"], str) or values["style"] not in ANNOTATION_STYLES:
                    raise ValueError("Invalid annotation style")
                current["style"] = values["style"]
            if "color" in values:
                if not _valid_color(values["color"]):
                    raise ValueError("Invalid annotation color")
                current["color"] = values["color"].lower()
        path = self._path(user_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        with NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, prefix=".preferences-", delete=False) as temporary:
            json.dump({"version": PREFERENCES_VERSION, **updated}, temporary, indent=2)
            temporary.write("\n")
            temporary.flush()
            temporary_path = Path(temporary.name)
        temporary_path.replace(path)
        return current
