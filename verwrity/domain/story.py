"""Small, UI-independent story model for the initial application shell."""

from dataclasses import dataclass, field
from datetime import datetime, timezone
from uuid import UUID, uuid4
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from verwrity.domain.scene_operations import SceneChange
from verwrity.domain.dialogue import DialogueAttribution
from verwrity.domain.scene_metadata import SceneMetadata
from verwrity.domain.project_features import ProjectFeatures
from verwrity.domain.world import WorldMap, WorldPage
from verwrity.domain.fingal import FingalSource
from verwrity.domain.wiki_provenance import WikiAnnotation, split_ai_annotations


@dataclass(slots=True)
class ManuscriptComment:
    """A human note with code-point anchors or retained detached evidence."""

    id: UUID
    start: int | None
    end: int | None
    quote: str
    body: str
    resolved: bool = False
    added_to_todo: bool = False
    detached: bool = False
    original_quote: str = ""
    prefix: str = ""
    suffix: str = ""

    def __post_init__(self) -> None:
        if not self.original_quote:
            self.original_quote = self.quote

    def detach(self) -> None:
        """Losing the passage must never destroy the author's observation."""
        self.start = self.end = None
        self.detached = True

    def as_dict(self) -> dict[str, object]:
        return {
            "id": str(self.id), "start": self.start, "end": self.end,
            "quote": self.quote, "body": self.body, "resolved": self.resolved,
            "added_to_todo": self.added_to_todo,
            "detached": self.detached, "original_quote": self.original_quote,
            "prefix": self.prefix, "suffix": self.suffix,
        }


@dataclass(slots=True)
class Scene:
    """A conceptual scene whose identity is independent of its position."""

    id: UUID
    title: str
    summary: str = ""
    text: str = ""
    historical: bool = False
    note_color: str | None = None
    comments: list[ManuscriptComment] = field(default_factory=list)
    revisions: list["SceneRevision"] = field(default_factory=list)
    metadata: SceneMetadata = field(default_factory=SceneMetadata)
    dialogue: list[DialogueAttribution] = field(default_factory=list)

    def next_revision_number(self) -> int:
        return max((revision.number for revision in self.revisions), default=0) + 1

    def record_revision(self) -> "SceneRevision":
        """Keep an immutable checkpoint of the current editable head."""
        revision = SceneRevision(
            id=uuid4(), number=self.next_revision_number(), text=self.text,
            recorded_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
            comments=tuple(SceneRevisionComment.from_comment(comment) for comment in self.comments),
            dialogue=tuple(self.dialogue),
        )
        self.revisions.append(revision)
        return revision

    def restore_revision(self, revision_id: UUID) -> "SceneRevision":
        """Snapshot the current head, then copy an older checkpoint into it."""
        source = next((revision for revision in self.revisions if revision.id == revision_id), None)
        if source is None:
            raise ValueError("Scene revision not found")
        current_head = self.record_revision()
        self.text = source.text
        self.comments = [comment.to_comment() for comment in source.comments]
        self.dialogue = list(source.dialogue)
        return current_head


@dataclass(frozen=True, slots=True)
class SceneRevisionComment:
    """Immutable copy of a comment anchor belonging to one text revision."""

    id: UUID
    start: int | None
    end: int | None
    quote: str
    body: str
    resolved: bool = False
    added_to_todo: bool = False
    detached: bool = False
    original_quote: str = ""
    prefix: str = ""
    suffix: str = ""

    @classmethod
    def from_comment(cls, comment: ManuscriptComment) -> "SceneRevisionComment":
        return cls(comment.id, comment.start, comment.end, comment.quote, comment.body,
                   comment.resolved, comment.added_to_todo, comment.detached,
                   comment.original_quote, comment.prefix, comment.suffix)

    def to_comment(self) -> ManuscriptComment:
        return ManuscriptComment(
            self.id, self.start, self.end, self.quote, self.body,
            self.resolved, self.added_to_todo, self.detached,
            self.original_quote, self.prefix, self.suffix,
        )

    def as_dict(self) -> dict[str, object]:
        return {
            "id": str(self.id), "start": self.start, "end": self.end,
            "quote": self.quote, "body": self.body, "resolved": self.resolved,
            "added_to_todo": self.added_to_todo,
            "detached": self.detached, "original_quote": self.original_quote,
            "prefix": self.prefix, "suffix": self.suffix,
        }


@dataclass(frozen=True, slots=True)
class SceneRevision:
    """A numbered, author-recorded snapshot of scene text and its comments."""

    id: UUID
    number: int
    text: str
    recorded_at: str = ""
    comments: tuple[SceneRevisionComment, ...] = ()
    dialogue: tuple[DialogueAttribution, ...] = ()

    def as_dict(self) -> dict[str, object]:
        return {
            "id": str(self.id), "number": self.number, "text": self.text,
            "recorded_at": self.recorded_at,
            "comments": [comment.as_dict() for comment in self.comments],
            "dialogue": [item.as_dict() for item in self.dialogue],
        }


@dataclass(slots=True)
class StoryboardColumn:
    """A human-defined field shown for every scene in the storyboard grid."""

    id: UUID
    title: str


@dataclass(frozen=True, slots=True)
class WikiRevision:
    """A wiki snapshot retaining authorship so edits can be reviewed/restored."""

    id: UUID
    title: str
    body: str = ""
    tags: tuple[str, ...] = ()
    saved_at: str = ""
    aliases: tuple[str, ...] = ()
    purpose: str = ""
    annotations: tuple[WikiAnnotation, ...] = ()
    world: WorldPage = field(default_factory=WorldPage)

    def __post_init__(self):
        object.__setattr__(self, "annotations", split_ai_annotations(self.body, self.annotations))


@dataclass(frozen=True, slots=True)
class WikiPage:
    """Human canonical knowledge and marked provisional AI passages."""

    id: UUID
    title: str
    body: str = ""
    tags: tuple[str, ...] = ()
    revisions: tuple[WikiRevision, ...] = ()
    aliases: tuple[str, ...] = ()
    purpose: str = ""
    annotations: tuple[WikiAnnotation, ...] = ()
    world: WorldPage = field(default_factory=WorldPage)

    def __post_init__(self):
        object.__setattr__(self, "annotations", split_ai_annotations(self.body, self.annotations))

    def provenance_dict(self):
        return {"purpose": self.purpose, "annotations": [item.as_dict() for item in self.annotations]}


@dataclass(slots=True)
class StoryProject:
    """The source-oriented project state used by the application.

    Scene text is the canonical manuscript representation. The aggregate
    manuscript property is a derived view for exports and compatibility; it is
    deliberately read-only so it cannot diverge from the scenes.

    Storyboard columns and their scene cells are separate human-authored
    planning data keyed by stable IDs; they never become manuscript content.
    """

    title: str
    project_id: UUID = field(default_factory=uuid4)
    scenes: list[Scene] = field(default_factory=list)
    wiki_pages: list[WikiPage] = field(default_factory=list)
    storyboard_columns: list[StoryboardColumn] = field(default_factory=list)
    storyboard_cells: dict[tuple[UUID, UUID], str] = field(default_factory=dict)
    spelling_dictionary: set[str] = field(default_factory=set)
    features: ProjectFeatures = field(default_factory=ProjectFeatures)
    maps: list[WorldMap] = field(default_factory=list)
    fingal_source: FingalSource | None = None
    scene_changes: list["SceneChange"] = field(default_factory=list)
    project_words: tuple[str, ...] = ()

    @property
    def manuscript(self) -> str:
        """Return the current scenes as plain manuscript text."""
        return "\n\n".join(scene.text for scene in self.current_scenes())

    def current_scenes(self) -> list[Scene]:
        return [scene for scene in self.scenes if not scene.historical]

    def scene(self, scene_id: UUID) -> Scene | None:
        return next((scene for scene in self.scenes if scene.id == scene_id), None)

    def storyboard_value(self, scene_id: UUID, column_id: UUID) -> str:
        return self.storyboard_cells.get((scene_id, column_id), "")

    def set_storyboard_value(self, scene_id: UUID, column_id: UUID, value: str) -> None:
        """Set one author-authored cell, omitting empty cells from storage."""
        if not value:
            self.storyboard_cells.pop((scene_id, column_id), None)
            return
        self.storyboard_cells[(scene_id, column_id)] = value

    @classmethod
    def demo(cls) -> "StoryProject":
        """Return a harmless example project for a fresh local installation."""
        scenes = [
            Scene(uuid4(), "Opening", "The story begins.", "Write the opening scene here."),
            Scene(uuid4(), "The discovery", "A new question changes the direction.", "Write the discovery scene here."),
            Scene(uuid4(), "Aftermath", "The characters respond to what they learned.", "Write the aftermath here."),
        ]
        wiki_pages = [
            WikiPage(uuid4(), "Project notes", "Human-authored story knowledge will live here."),
            WikiPage(uuid4(), "Characters", "Add characters, relationships, and relevant facts."),
        ]
        return cls(
            title="Untitled story",
            scenes=scenes,
            wiki_pages=wiki_pages,
        )
