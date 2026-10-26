#!/usr/bin/env python3
"""Generate a replayable Verwrity archive from a small Markdown-like fixture.

The fixture format is deliberately line-oriented. Content belongs to the most
recent scene or wiki directive, so ordinary Markdown can be used inside it.
Archive serialization stays in ``verwrity.project.archive``; this script only
turns readable fixture text into the canonical domain model.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from uuid import NAMESPACE_URL, UUID, uuid5

if __package__ in {None, ""}:  # Allow ``python scripts/generate_fixture.py`` from a checkout.
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from verwrity.domain.story import Scene, StoryProject, WikiPage
from verwrity.project.archive import export_project


DEFAULT_LIBRARY_ROOT = Path(__file__).resolve().parents[1] / "user_files" / "local-user"


class FixtureFormatError(ValueError):
    """Raised when a fixture is missing a required directive or value."""


def _directive(line: str) -> tuple[str, str] | None:
    stripped = line.strip()
    if not stripped.startswith("@"):
        return None
    name, separator, value = stripped[1:].partition(":")
    if not separator:
        name, _, value = stripped[1:].partition(" ")
    return name.strip().lower(), value.strip()


def _stable_id(project_title: str, kind: str, title: str, index: int) -> UUID:
    key = f"verwrity-fixture:{project_title}:{kind}:{index}:{title}"
    return uuid5(NAMESPACE_URL, key)


def _aliases(raw: str, title: str) -> tuple[str, ...]:
    result: list[str] = []
    seen = {title.casefold()}
    for item in raw.split(","):
        alias = " ".join(item.split())[:100]
        if alias and alias.casefold() not in seen:
            result.append(alias)
            seen.add(alias.casefold())
        if len(result) == 20:
            break
    return tuple(result)


def parse_fixture(source: str) -> StoryProject:
    """Parse fixture Markdown into a ``StoryProject`` with stable IDs."""
    project_title = ""
    scenes: list[Scene] = []
    wiki_pages: list[WikiPage] = []
    current_kind: str | None = None
    current_title = ""
    current_summary = ""
    current_tags: tuple[str, ...] = ()
    current_aliases: tuple[str, ...] = ()
    content: list[str] = []

    def finish() -> None:
        nonlocal content, current_kind, current_title, current_summary, current_tags, current_aliases
        if current_kind is None:
            if any(line.strip() for line in content):
                raise FixtureFormatError("Content appears before the first @scene or @wiki directive")
        elif current_kind == "scene":
            scenes.append(Scene(_stable_id(project_title, "scene", current_title, len(scenes)), current_title, current_summary, _body(content)))
        elif current_kind == "wiki":
            wiki_pages.append(WikiPage(_stable_id(project_title, "wiki", current_title, len(wiki_pages)), current_title, _body(content), current_tags, (), current_aliases))
        content = []
        current_kind = None
        current_title = ""
        current_summary = ""
        current_tags = ()
        current_aliases = ()

    for line_number, line in enumerate(source.splitlines(), 1):
        directive = _directive(line)
        if directive is None:
            content.append(line)
            continue
        name, value = directive
        if name == "project":
            if project_title:
                raise FixtureFormatError(f"Line {line_number}: @project may appear only once")
            if not value:
                raise FixtureFormatError(f"Line {line_number}: @project needs a title")
            project_title = value
        elif name in {"scene", "wiki"}:
            finish()
            if not project_title:
                raise FixtureFormatError(f"Line {line_number}: declare @project before @{name}")
            if not value:
                raise FixtureFormatError(f"Line {line_number}: @{name} needs a title")
            current_kind, current_title = name, value
        elif name == "summary":
            if current_kind != "scene":
                raise FixtureFormatError(f"Line {line_number}: @summary belongs inside a scene")
            current_summary = value
        elif name == "tags":
            if current_kind != "wiki":
                raise FixtureFormatError(f"Line {line_number}: @tags belongs inside a wiki page")
            current_tags = tuple(dict.fromkeys(tag.strip() for tag in value.split(",") if tag.strip()))
        elif name == "aliases":
            if current_kind != "wiki":
                raise FixtureFormatError(f"Line {line_number}: @aliases belongs inside a wiki page")
            current_aliases = _aliases(value, current_title)
        else:
            raise FixtureFormatError(f"Line {line_number}: unknown directive @{name}")

    finish()
    if not project_title:
        raise FixtureFormatError("Fixture needs an @project directive")
    if not scenes and not wiki_pages:
        raise FixtureFormatError("Fixture needs at least one @scene or @wiki section")
    project_id = uuid5(NAMESPACE_URL, f"verwrity-fixture:project:{project_title}")
    return StoryProject(project_title, project_id, scenes, wiki_pages)


def _body(lines: list[str]) -> str:
    return "\n".join(lines).strip()


def generate_fixture(input_path: Path, output_path: Path | None = None) -> Path:
    """Generate an archive in the local user library, or at an explicit path."""
    project = parse_fixture(input_path.read_text(encoding="utf-8"))
    filename, data = export_project(project)
    destination = output_path or DEFAULT_LIBRARY_ROOT / filename
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(data)
    return destination


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate a Verwrity .verwrity.zip fixture from Markdown-like source")
    parser.add_argument("source", type=Path, help="Fixture source file")
    parser.add_argument("-o", "--output", type=Path, help="Output .verwrity.zip path")
    args = parser.parse_args()
    try:
        destination = generate_fixture(args.source, args.output)
    except (OSError, FixtureFormatError) as exc:
        parser.error(str(exc))
    print(destination)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
