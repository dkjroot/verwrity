"""In-memory working copies with serialized, recoverable persistence."""

from copy import deepcopy
from dataclasses import fields
from pathlib import Path
import logging

from verwrity.domain.story import StoryProject
from verwrity.project.archive import export_project, import_project
from verwrity.project.drafts import DraftRepository
from verwrity.project.files import PROJECT_LOCK, atomic_write

logger = logging.getLogger(__name__)


class ProjectStore:
    def __init__(self, project: StoryProject | None = None, persist_path: Path | None = None,
                 drafts: DraftRepository | None = None, recover: bool = True) -> None:
        self._persist_path = persist_path
        self.drafts = drafts
        self._project = project or StoryProject.demo()
        self.recovered_from_disk = False
        self.generation = drafts.generation(self._project.project_id) if drafts else None
        if drafts and recover:
            latest = drafts.latest(self._project.project_id)
            if latest:
                self._project = latest.project
                self.recovered_from_disk = True
        elif persist_path and persist_path.exists():
            try:
                self._project = import_project(persist_path.read_bytes())
                self.recovered_from_disk = True
            except (OSError, ValueError) as error:
                logger.warning("Project recovery: draft could not be loaded (%s); using fallback", type(error).__name__)

    def get(self) -> StoryProject:
        return self._project

    def ensure_current(self) -> None:
        if self.drafts:
            self.drafts.ensure_current(self._project.project_id, self.generation)

    def replace(self, project: StoryProject) -> None:
        with PROJECT_LOCK:
            previous = (self._project, self.generation, self.recovered_from_disk)
            self._project = project
            self.generation = self.drafts.generation(project.project_id) if self.drafts else None
            self.recovered_from_disk = False
            try:
                self.commit()
            except Exception:
                self._project, self.generation, self.recovered_from_disk = previous
                raise

    def acknowledge_recovery(self) -> None:
        self.recovered_from_disk = False

    def rollback(self, snapshot: StoryProject, generation: str | None, recovered: bool) -> None:
        """Restore a failed mutation while preserving live scene identities."""
        if self._project.project_id == snapshot.project_id:
            by_id = {scene.id: scene for scene in self._project.scenes}
            scenes = []
            for source in snapshot.scenes:
                target = by_id.get(source.id, deepcopy(source))
                for item in fields(source):
                    setattr(target, item.name, deepcopy(getattr(source, item.name)))
                scenes.append(target)
            for item in fields(snapshot):
                setattr(self._project, item.name, scenes if item.name == "scenes" else deepcopy(getattr(snapshot, item.name)))
        else:
            self._project = snapshot
        self.generation = generation
        self.recovered_from_disk = recovered

    def open(self, project: StoryProject) -> None:
        """Offer this project's recovery without overwriting it on open."""
        with PROJECT_LOCK:
            latest = self.drafts.latest(project.project_id) if self.drafts else None
            self._project = latest.project if latest else project
            self.generation = self.drafts.generation(project.project_id) if self.drafts else None
            self.recovered_from_disk = bool(latest and latest.project != project)

    def commit(self) -> None:
        with PROJECT_LOCK:
            if self.drafts:
                self.generation = self.drafts.save(deepcopy(self._project), self.generation)
            elif self._persist_path is not None:
                _, data = export_project(deepcopy(self._project))
                atomic_write(self._persist_path, data)
