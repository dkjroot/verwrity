"""Server-side library for user-owned Verwrity projects."""

from __future__ import annotations

from pathlib import Path
from copy import deepcopy
from uuid import uuid4

from verwrity.domain.story import StoryProject
from verwrity.project.archive import export_project, import_project
from verwrity.project.files import PROJECT_LOCK, atomic_write

class ProjectLibrary:
    """Store project archives under an isolated directory for each user.

    Authentication is intentionally outside this small class. Callers provide
    a user identifier, which means adding sessions/accounts later will not
    require changing the on-disk layout or mixing users' files.
    """

    def __init__(self, root: Path | str = "user_files") -> None:
        self.root = Path(root)

    def _user_dir(self, user_id: str) -> Path:
        # User IDs are identifiers, not paths; reject traversal before joining.
        if not user_id or Path(user_id).name != user_id or user_id in {".", ".."}:
            raise ValueError("Invalid user identifier")
        directory = self.root / user_id
        directory.mkdir(parents=True, exist_ok=True)
        return directory

    def save(self, user_id: str, project: StoryProject) -> Path:
        with PROJECT_LOCK:
            return self._save(user_id, project)

    def _save(self, user_id: str, project: StoryProject) -> Path:
        filename, data = export_project(project)
        directory = self._user_dir(user_id)
        destination = directory / filename
        if destination.exists():
            try:
                existing = import_project(destination.read_bytes())
            except ValueError:
                existing = None
            if existing is None or existing.project_id != project.project_id:
                stem = destination.name.removesuffix(".verwrity.zip")
                number = 2
                while (candidate := directory / f"{stem} ({number}).verwrity.zip").exists():
                    try:
                        if import_project(candidate.read_bytes()).project_id == project.project_id:
                            break
                    except (OSError, ValueError):
                        pass
                    number += 1
                destination = directory / f"{stem} ({number}).verwrity.zip"
        atomic_write(destination, data)
        # Publish the new archive first. A failed rename must not remove the
        # last readable copy, and unrelated same-title projects remain intact.
        for candidate in directory.glob("*.verwrity.zip"):
            if candidate == destination:
                continue
            try:
                same_project = import_project(candidate.read_bytes()).project_id == project.project_id
            except (OSError, ValueError):
                continue
            if same_project:
                candidate.unlink()
        return destination

    def duplicate(self, user_id: str, project: StoryProject, title: str) -> Path:
        """Create a separate project identity from the current project."""
        duplicate = deepcopy(project)
        duplicate.title = title
        duplicate.project_id = uuid4()
        return self.save(user_id, duplicate)

    def load(self, user_id: str, filename: str) -> StoryProject:
        path = self._user_dir(user_id) / filename
        if not path.name.endswith(".verwrity.zip") or path.parent != self._user_dir(user_id):
            raise ValueError("Invalid project filename")
        return import_project(path.read_bytes())

    def list(self, user_id: str) -> list[str]:
        directory = self._user_dir(user_id)
        paths = directory.glob("*.verwrity.zip")
        return sorted(path.name for path in paths)

    def find_project_id(self, user_id: str, project_id):
        """Return a named archive matching an identity, if the library has one."""
        directory = self._user_dir(user_id)
        for filename in sorted(self.list(user_id), key=lambda name: (directory / name).stat().st_mtime_ns, reverse=True):
            try:
                project = self.load(user_id, filename)
            except (OSError, ValueError):
                continue
            if project.project_id == project_id:
                return filename, project
        return None

    def delete(self, user_id: str, filename: str) -> None:
        path = self._user_dir(user_id) / filename
        if not path.name.endswith(".verwrity.zip") or path.parent != self._user_dir(user_id):
            raise ValueError("Invalid project filename")
        path.unlink(missing_ok=True)
