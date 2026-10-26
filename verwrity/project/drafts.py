"""User/project recovery snapshots, independent of browser session lifetime."""

import os
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path
from uuid import UUID

from verwrity.domain.story import StoryProject
from verwrity.project.archive import export_project, import_project
from verwrity.project.files import PROJECT_LOCK, atomic_write


class DraftConflict(ValueError):
    """Another session saved this project after this working copy was loaded."""


@dataclass(frozen=True)
class RecoveryDraft:
    project: StoryProject
    path: Path


class DraftRepository:
    NAMES = ("current.verwrity.zip", "previous-1.verwrity.zip", "previous-2.verwrity.zip")

    def __init__(self, root: Path, user_id: str):
        if not user_id or Path(user_id).name != user_id or user_id in {".", ".."}:
            raise ValueError("Invalid user identifier")
        self.root = Path(root) / user_id / "drafts"

    def directory(self, project_id: UUID) -> Path:
        return self.root / str(UUID(str(project_id)))

    def generation(self, project_id: UUID) -> str | None:
        current = self.directory(project_id) / self.NAMES[0]
        try:
            return sha256(current.read_bytes()).hexdigest()
        except FileNotFoundError:
            return None

    def ensure_current(self, project_id: UUID, expected: str | None) -> None:
        if self.generation(project_id) != expected:
            raise DraftConflict("This project was saved in another session. Keep your edits and reopen the project before retrying.")

    def latest(self, project_id: UUID) -> RecoveryDraft | None:
        directory = self.directory(project_id)
        # Fall back only within the selected project; a corrupt latest file
        # must not cause another project's manuscript to appear.
        for name in self.NAMES:
            path = directory / name
            try:
                project = import_project(path.read_bytes())
                if project.project_id == project_id:
                    return RecoveryDraft(project, path)
            except (OSError, ValueError):
                continue
        return None

    def list(self) -> list[RecoveryDraft]:
        result = []
        if self.root.exists():
            for directory in self.root.iterdir():
                try:
                    project_id = UUID(directory.name)
                except ValueError:
                    continue
                recovery = self.latest(project_id)
                if recovery:
                    result.append(recovery)
        return sorted(result, key=lambda item: item.project.title.casefold())

    def save(self, project: StoryProject, expected: str | None) -> str:
        with PROJECT_LOCK:
            return self._save(project, expected)

    def discard(self, project_id: UUID, *, keep_current: bool = False) -> None:
        """Remove only this user's selected recovery snapshots after replacement."""
        with PROJECT_LOCK:
            directory = self.directory(project_id)
            names = self.NAMES
            for name in names[1:] if keep_current else names:
                (directory / name).unlink(missing_ok=True)

    def _save(self, project: StoryProject, expected: str | None) -> str:
        self.ensure_current(project.project_id, expected)
        _, data = export_project(project)
        directory = self.directory(project.project_id)
        current, previous, older = (directory / name for name in self.NAMES)
        try:
            old_data = current.read_bytes()
            old_project = import_project(old_data)
        except (OSError, ValueError):
            old_data = None
            old_project = None
        if old_project == project:
            return sha256(old_data).hexdigest()
        if old_project is not None and old_project.project_id == project.project_id:
            try:
                previous_data = previous.read_bytes()
                if import_project(previous_data).project_id != project.project_id:
                    previous_data = None
            except (OSError, ValueError):
                previous_data = None
            if previous_data is not None:
                atomic_write(older, previous_data)
            atomic_write(previous, old_data)
        # Write current last, so interruption leaves a readable fallback.
        atomic_write(current, data)
        return sha256(data).hexdigest()

    def migrate_legacy(self, legacy_root: Path) -> None:
        """Migrate known local-user session drafts, retaining three per project.

        Unknown/corrupt files remain untouched for manual recovery. Callers
        must establish ownership; old global files contain no user identity.
        """
        with PROJECT_LOCK:
            self._migrate_legacy(legacy_root)

    @staticmethod
    def legacy_project_id(legacy_root: Path, session_id: str) -> UUID | None:
        """Resolve an existing local session before its legacy file is migrated."""
        try:
            identity = UUID(session_id).hex
        except (ValueError, TypeError, AttributeError):
            return None
        try:
            return import_project((legacy_root / f"{identity}.verwrity.zip").read_bytes()).project_id
        except (OSError, ValueError):
            return None

    def _migrate_legacy(self, legacy_root: Path) -> None:
        groups = {}
        legacy_paths = legacy_root.glob("*.verwrity.zip")
        for path in legacy_paths:
            try:
                data = path.read_bytes()
                project = import_project(data)
                groups.setdefault(project.project_id, []).append((path.stat().st_mtime_ns, path, data))
            except (OSError, ValueError):
                continue
        for project_id, entries in groups.items():
            directory = self.directory(project_id)
            candidates = list(entries)
            for name in self.NAMES:
                path = directory / name
                try:
                    data = path.read_bytes()
                    if import_project(data).project_id == project_id:
                        candidates.append((path.stat().st_mtime_ns, path, data))
                except (OSError, ValueError):
                    continue
            newest = sorted(candidates, key=lambda entry: entry[0], reverse=True)[:3]
            for name, (modified, _, data) in reversed(list(zip(self.NAMES, newest))):
                destination = directory / name
                atomic_write(destination, data)
                import_project(destination.read_bytes())
                os.utime(destination, ns=(modified, modified))
            for _, source, _ in entries:
                source.unlink()
