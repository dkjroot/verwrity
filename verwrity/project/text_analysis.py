"""User-authored analysis prompts; never part of a story archive."""
from dataclasses import asdict, replace
import json
from pathlib import Path
import re
from tempfile import NamedTemporaryFile
from uuid import UUID, uuid4

from verwrity.analysis.text import BUILTIN_DEFINITIONS, TextAnalysisDefinition
from verwrity.project.preferences import ANNOTATION_STYLES

MAX_CUSTOM_ANALYSES = 20


class UserTextAnalyses:
    def __init__(self, root: Path | str = "user_files"):
        self.root = Path(root)

    def _path(self, user_id):
        if not user_id or Path(user_id).name != user_id or user_id in {".", ".."}:
            raise ValueError("Invalid user identifier")
        return self.root / user_id / "text_analyses.json"

    @staticmethod
    def _checked(values):
        if not isinstance(values, dict):
            raise ValueError("Enter an analysis name, prompt, and colour.")
        name, prompt, color = values.get("name"), values.get("prompt"), values.get("color", "#8b5cf6")
        if not isinstance(name, str) or not name.strip() or len(name) > 80:
            raise ValueError("Enter an analysis name up to 80 characters.")
        if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 8000:
            raise ValueError("Enter a review prompt up to 8,000 characters.")
        if not isinstance(color, str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", color):
            raise ValueError("Choose a valid highlight colour.")
        style = values.get("style", "highlight")
        if not isinstance(style, str) or style not in ANNOTATION_STYLES:
            raise ValueError("Choose a valid annotation style.")
        enabled = values.get("enabled", False)
        if not isinstance(enabled, bool):
            raise ValueError("Choose whether the analysis is enabled.")
        return name.strip(), prompt.strip(), color.lower(), style, enabled

    def load(self, user_id) -> list[TextAnalysisDefinition]:
        path = self._path(user_id)
        definitions = list(BUILTIN_DEFINITIONS.values())
        try:
            saved = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return definitions
        if not isinstance(saved, list):
            return definitions
        seen = set(BUILTIN_DEFINITIONS)
        for item in saved[:MAX_CUSTOM_ANALYSES + len(BUILTIN_DEFINITIONS)]:
            try:
                if not isinstance(item, dict) or not isinstance(item.get("id"), str):
                    continue
                identity = item["id"]
                default = BUILTIN_DEFINITIONS.get(identity)
                if default:
                    # Old settings stored a copy of the shipped prompt. Only
                    # explicit overrides should hide future default improvements.
                    _, prompt, color, style, enabled = self._checked({"name": default.name,
                        "prompt": item.get("prompt_override", default.prompt), "color": item.get("color", default.color),
                        "style": item.get("style", default.style), "enabled": item.get("enabled", False)})
                    definitions = [replace(default, prompt=prompt, color=color, style=style, enabled=enabled) if entry.id == identity else entry
                                   for entry in definitions]
                    continue
                name, prompt, color, style, enabled = self._checked(item)
                UUID(identity)
                if identity in seen:
                    continue
                seen.add(identity)
                definitions.append(TextAnalysisDefinition(identity, name, prompt, color, style=style, enabled=enabled))
            except (ValueError, KeyError, TypeError, AttributeError):
                continue
        return definitions

    def update(self, user_id, values, identity=None):
        definitions = self.load(user_id)
        existing = next((item for item in definitions if item.id == identity), None)
        if identity is not None and existing is None:
            raise ValueError("Analysis not found.")
        if existing and existing.builtin:
            if (not isinstance(values, dict) or not values
                    or set(values) - {"prompt", "color", "style", "enabled", "restore_default"}):
                raise ValueError("Edit the built-in prompt or appearance, or restore its default prompt.")
            if "restore_default" in values and not isinstance(values["restore_default"], bool):
                raise ValueError("Choose a valid restore-default option.")
            if values.get("restore_default") and "prompt" in values:
                raise ValueError("Choose either a prompt edit or restore default.")
            prompt = BUILTIN_DEFINITIONS[identity].prompt if values.get("restore_default") else values.get("prompt", existing.prompt)
            values = {"name": existing.name, "prompt": prompt, "color": values.get("color", existing.color),
                      "style": values.get("style", existing.style), "enabled": values.get("enabled", existing.enabled)}
        elif isinstance(values, dict) and "restore_default" in values:
            raise ValueError("Only built-in analyses have a default prompt to restore.")
        elif existing and isinstance(values, dict):
            values = {**asdict(existing), **values}
        name, prompt, color, style, enabled = self._checked(values)
        if existing:
            definition = replace(existing, name=name, prompt=prompt, color=color, style=style, enabled=enabled)
            definitions = [definition if item.id == identity else item for item in definitions]
        else:
            if sum(not item.builtin for item in definitions) >= MAX_CUSTOM_ANALYSES:
                raise ValueError("Keep up to 20 custom analyses.")
            definition = TextAnalysisDefinition(str(uuid4()), name, prompt, color, style=style, enabled=enabled)
            definitions.append(definition)
        self._save(user_id, definitions)
        return definition

    def delete(self, user_id, identity):
        definitions = self.load(user_id)
        if identity in BUILTIN_DEFINITIONS:
            raise ValueError("The built-in detector cannot be deleted.")
        if not any(item.id == identity for item in definitions):
            raise ValueError("Analysis not found.")
        self._save(user_id, [item for item in definitions if item.id != identity])

    def _save(self, user_id, definitions):
        path = self._path(user_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        saved = []
        for definition in definitions:
            if definition.builtin:
                value = {"id": definition.id, "color": definition.color, "style": definition.style, "enabled": definition.enabled}
                if definition.prompt_overridden:
                    value["prompt_override"] = definition.prompt
            else:
                value = asdict(definition)
            saved.append(value)
        with NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, prefix=".text-analyses-", delete=False) as temporary:
            json.dump(saved, temporary, ensure_ascii=False, indent=2)
            temporary.write("\n")
            temporary_path = Path(temporary.name)
        temporary_path.replace(path)
