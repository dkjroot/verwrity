"""Author-selected project capabilities, independent of workspace layout."""

from dataclasses import asdict, dataclass, fields


@dataclass(frozen=True, slots=True)
class ProjectFeatures:
    fingal_mode: bool = False
    map_editor: bool = False
    character_editor: bool = False

    def __post_init__(self):
        if any(type(getattr(self, item.name)) is not bool for item in fields(self)):
            raise ValueError("Project features must be booleans")

    @classmethod
    def from_dict(cls, value):
        if not isinstance(value, dict) or value.keys() - {item.name for item in fields(cls)}:
            raise ValueError("Invalid project features")
        return cls(**value)

    def as_dict(self):
        return asdict(self)

    @property
    def map_enabled(self) -> bool:
        return self.fingal_mode or self.map_editor

    @property
    def characters_enabled(self) -> bool:
        return self.fingal_mode or self.character_editor

    @property
    def fingal_export_enabled(self) -> bool:
        return self.fingal_mode
