"""Labels and optional suggestions for the scene context card."""

from dataclasses import dataclass


@dataclass(frozen=True)
class MetadataField:
    name: str
    label: str
    hint: str
    suggestions: tuple[str, ...] = ()
    multiline: bool = False


METADATA_FIELDS = (
    MetadataField("pov_character", "Point-of-view character", "Whose eyes are we seeing this scene through?"),
    MetadataField("narrator", "Narrator", "Who's telling the story? They might not be the viewpoint character."),
    MetadataField("narrative_perspective", "Narrative perspective", "Choose a suggestion, or describe it in your own words.",
                  ("First person", "Second person", "Third-person limited", "Third-person omniscient",
                   "Third-person objective", "Multiple viewpoints", "Not applicable")),
    MetadataField("tense", "Narrative tense", "e.g. past, present, or deliberately mixed.",
                  ("Past", "Present", "Mixed", "Not applicable")),
    MetadataField("location", "Location", "Where does this scene happen?"),
    MetadataField("time_period", "Time period", "e.g. Victorian Britain, 2080, or an invented era."),
    MetadataField("story_time", "Story time / chronology", "e.g. day 3, before the voyage, or a flashback."),
    MetadataField("voice_notes", "Voice and style notes", "How should it sound? Note dialect, rhythm, tone or any deliberate changes of voice.", multiline=True),
    MetadataField("purpose", "Scene purpose / intent", "What do you want this scene to do for the story?", multiline=True),
)
