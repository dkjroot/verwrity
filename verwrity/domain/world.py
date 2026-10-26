"""Authored and imported world records attached to stable wiki page identities.

These describe a starting world, never a player's current location or equipment.
They are independent of Fingal's runtime and of the browser.
"""

from dataclasses import asdict, dataclass, field, fields, is_dataclass, replace
import json
import math
import re
from types import UnionType
from typing import Literal, get_args, get_origin, get_type_hints
from uuid import UUID


DIRECTIONS = ("north_west", "north", "north_east", "west", "east", "south_west", "south", "south_east")
OPPOSITE = dict(zip(DIRECTIONS, reversed(DIRECTIONS)))
SLOTS = ("head", "neck", "right_hand", "left_hand", "back", "waist", "feet", "shoulders",
         "left_hand_glove", "right_hand_glove", "left_wrist", "right_wrist",
         "outfit_inner_layer", "outfit_mid_layer", "outfit_outer_layer",
         "torso_inner_layer", "torso_mid_layer", "torso_outer_layer",
         "legs_inner_layer", "legs_mid_layer", "legs_outer_layer")
SKILLS = ("heavy_blow", "precise_strike", "second_wind", "field_care", "remedy")


def bounded(default, low=0, high=1000000):
    return field(default=default, metadata={"min": low, "max": high})


def text(default="", limit=500, required=False, identifier=False):
    return field(default=default, metadata={"limit": limit, "required": required, "identifier": identifier})


def _decode(hint, value):
    origin, args = get_origin(hint), get_args(hint)
    if origin is UnionType:
        if value is None and type(None) in args:
            return None
        for arg in args:
            if arg is type(None):
                continue
            try:
                return _decode(arg, value)
            except (ValueError, TypeError):
                pass
        raise ValueError("Invalid world record field type")
    if origin is Literal:
        if value not in args or not isinstance(value, str):
            raise ValueError("Invalid world record choice")
        return value
    if origin is tuple:
        if not isinstance(value, (list, tuple)) or len(value) > 100:
            raise ValueError("World record lists must contain at most 100 entries")
        return tuple(_decode(args[0], item) for item in value)
    if hint is UUID:
        return UUID(value) if isinstance(value, str) else value if isinstance(value, UUID) else _invalid()
    if is_dataclass(hint):
        return read_record(hint, value)
    if type(value) is not hint:
        raise ValueError("Invalid world record field type")
    if hint is str and len(value) > 100000:
        raise ValueError("World record text is too long")
    if hint is float and not math.isfinite(value):
        raise ValueError("World record numbers must be finite")
    return value


def _invalid():
    raise ValueError("Invalid world record identity")


def read_record(record_type, value):
    if not isinstance(value, dict) or value.keys() - {f.name for f in fields(record_type)}:
        raise ValueError("Unknown world record field")
    hints = get_type_hints(record_type)
    result = record_type(**{name: _decode(hints[name], raw) for name, raw in value.items()})
    # Apply the same validation to API input and persisted source data.
    for item in fields(result):
        raw = getattr(result, item.name)
        if raw is None:
            continue
        rules = item.metadata
        if isinstance(raw, str):
            if len(raw) > rules.get("limit", 2000) or (rules.get("required") and not raw.strip()):
                raise ValueError(f"Invalid {item.name}: check its text length")
            if raw and rules.get("identifier") and not re.fullmatch(r"[A-Za-z0-9_.-]+", raw):
                raise ValueError(f"Invalid {item.name}: use letters, numbers, dots, hyphens or underscores")
        if type(raw) in (int, float) and not rules.get("min", -1000000) <= raw <= rules.get("max", 1000000):
            raise ValueError(f"Invalid {item.name}: outside its allowed range")
    return result


def record_data(record):
    return json.loads(json.dumps(asdict(record), default=str, ensure_ascii=False))


@dataclass(frozen=True, slots=True)
class Attribute:
    name: str = text(required=True)
    value: str = text()


@dataclass(frozen=True, slots=True)
class InventoryItem:
    item: str = text(required=True, identifier=True)
    quantity: int = bounded(1, 1)
    mount: str = text()
    money_balance: int | None = field(default=None, metadata={"min": 0, "max": 9_000_000_000_000_000})


@dataclass(frozen=True, slots=True)
class EquippedItem:
    item: str = text(required=True, identifier=True)
    slot: str = text(required=True)


@dataclass(frozen=True, slots=True)
class Condition:
    id: Literal["wound", "fever"] = "wound"
    severity: int = bounded(1, 1, 3)


@dataclass(frozen=True, slots=True)
class CombatProfile:
    might: int = bounded(1, 0, 8)
    agility: int = bounded(1, 0, 8)
    resolve: int = bounded(1, 0, 8)
    max_health: int = bounded(24, 1, 200)
    max_stamina: int = bounded(6, 3, 20)
    skills: tuple[str, ...] = ()
    conditions: tuple[Condition, ...] = ()
    experience_reward: int = bounded(0, 0, 1000)
    surrender_allowed: bool = True
    grapple_allowed: bool = True
    fighting_style: str = text(limit=400)

    def __post_init__(self):
        if len(set(self.skills)) != len(self.skills) or set(self.skills) - set(SKILLS):
            raise ValueError("Choose distinct supported combat skills")
        if len({c.id for c in self.conditions}) != len(self.conditions):
            raise ValueError("Conditions must be unique")


@dataclass(frozen=True, slots=True)
class Motive:
    kind: Literal["robbery", "prejudice", "coercion", "duty", "revenge"] = "duty"
    priority: int = bounded(3, 0, 10)
    activation: Literal["always", "ally_in_combat"] = "always"
    target_tags: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class BehaviourProfile:
    aggression: int = bounded(1, 0, 10)
    caution: int = bounded(5, 0, 10)
    acquisitiveness: int = bounded(2, 0, 10)
    ruthlessness: int = bounded(2, 0, 10)
    motives: tuple[Motive, ...] = ()

    def __post_init__(self):
        if len(self.motives) > 3:
            raise ValueError("Use at most three motives")


@dataclass(frozen=True, slots=True)
class AppearancePreference:
    tag: Literal["poor", "common", "merchant", "noble", "clean", "dirty", "unkempt"] = "common"
    value: int = bounded(0, -3, 3)


@dataclass(frozen=True, slots=True)
class ApproachPreference:
    approach: Literal["courtesy", "appeal", "bargain", "flirt", "offer_help", "apology", "insult", "threat", "coercion"] = "courtesy"
    response: Literal["welcome", "neutral", "dislike"] = "neutral"


@dataclass(frozen=True, slots=True)
class SocialProfile:
    disposition: int = bounded(0, -5, 5)
    stranger_reserve: int = bounded(1, 0, 3)
    pressure_resistance: int = bounded(5, 0, 10)
    appearance_preferences: tuple[AppearancePreference, ...] = ()
    approach_preferences: tuple[ApproachPreference, ...] = ()

    def __post_init__(self):
        if (len({p.tag for p in self.appearance_preferences}) != len(self.appearance_preferences)
                or len({p.approach for p in self.approach_preferences}) != len(self.approach_preferences)):
            raise ValueError("Social preferences must be unique")


@dataclass(frozen=True, slots=True)
class Goal:
    id: str = text(required=True, identifier=True, limit=80)
    description: str = text(required=True)
    priority: int = bounded(3, 0, 10)
    involvement: Literal["self", "player", "either"] = "either"
    activation: Literal["always", "friendly", "grievance", "afraid", "injured", "trade", "violence", "interruption"] = "always"


@dataclass(frozen=True, slots=True)
class Bond:
    character_page_id: UUID | None = None
    kind: Literal["family", "ally", "employer"] = "ally"


@dataclass(frozen=True, slots=True)
class PrivateFact:
    id: str = text(required=True, identifier=True, limit=80)
    text: str = field(default="", metadata={"required": True, "limit": 800})
    disclosure: str = field(default="Share only when natural in this conversation.", metadata={"required": True, "limit": 800})
    question_required: bool = False
    stolen_item: str = field(default="")
    rightful_owner: UUID | None = None
    culprit: UUID | None = None

    def __post_init__(self):
        if any((self.stolen_item, self.rightful_owner, self.culprit)) and not all((self.stolen_item, self.rightful_owner, self.culprit)):
            raise ValueError("A witnessed theft needs an item, rightful owner and culprit")


@dataclass(frozen=True, slots=True)
class RewardMoney:
    currency: str = text(required=True, identifier=True)
    maximum: int = bounded(0)


@dataclass(frozen=True, slots=True)
class PersonalNeed:
    id: str = text(required=True, identifier=True, limit=80)
    description: str = text(required=True, limit=800)
    visible_signs: str = text(limit=400)
    item_id: str = text(required=True, identifier=True, limit=160)
    goodwill_max: int = bounded(3, 0, 5)
    reward_money_max: tuple[RewardMoney, ...] = ()
    reward_items: tuple[str, ...] = ()
    guaranteed_items: tuple[str, ...] = ()
    response: str = text(limit=800)

    def __post_init__(self):
        reward_sets = (self.reward_items, self.guaranteed_items)
        if any(len(set(values)) != len(values) or self.item_id in values or len(values) > 8 for values in reward_sets) or set(self.reward_items) & set(self.guaranteed_items):
            raise ValueError("Need rewards must be distinct and exclude the requested item")
        if len({r.currency for r in self.reward_money_max}) != len(self.reward_money_max) or len(self.reward_money_max) > 8:
            raise ValueError("Reward currencies must be distinct (at most eight)")


@dataclass(frozen=True, slots=True)
class CharacterSheet:
    character_id: str = text(required=True, identifier=True, limit=160)
    player_template: bool = False
    skin_condition: Literal["unspecified", "clean", "dirty"] = "unspecified"
    gender: str = text()
    pronouns: str = text()
    age: int | None = field(default=None, metadata={"min": 0, "max": 10000})
    description: str = text(limit=10000)
    backstory: str = text(limit=10000)
    role: str = text()
    home_location: UUID | None = None
    public_role: bool = False
    nature: Literal["person", "creature"] = "person"
    alignment: Literal["not_applicable", "good", "evil"] = "not_applicable"
    visible_strength: int = bounded(0, 0, 5)
    money: int = bounded(0, 0, 9_000_000_000_000_000)
    name_aliases: tuple[str, ...] = ()
    factions: tuple[str, ...] = ()
    attributes: tuple[Attribute, ...] = ()
    inventory: tuple[InventoryItem, ...] = ()
    equipped: tuple[EquippedItem, ...] = ()
    combat_loadout: tuple[str, ...] = ()
    combat: CombatProfile | None = None
    behaviour: BehaviourProfile | None = None
    social_profile: SocialProfile | None = None
    goals: tuple[Goal, ...] = ()
    bonds: tuple[Bond, ...] = ()
    needs: tuple[PersonalNeed, ...] = ()
    private_facts: tuple[PrivateFact, ...] = ()
    recovery_authority: bool = False

    def __post_init__(self):
        if self.player_template and len(self.backstory) > 4000:
            raise ValueError("Player backstory must fit within 4000 characters")
        if self.nature == "person" and self.alignment != "not_applicable":
            raise ValueError("People use Not applicable alignment; their aggression depends on circumstances")
        carried = {entry.item for entry in self.inventory}
        if len(carried) != len(self.inventory):
            raise ValueError("Inventory items must be unique; use quantity for multiples")
        parents = {entry.item: entry.mount for entry in self.inventory}
        for item in parents:
            seen = set()
            while parents.get(item):
                if item in seen or parents[item] not in carried:
                    raise ValueError("Inventory mounts must be carried and cannot form a cycle")
                seen.add(item)
                item = parents[item]
        if (len({entry.slot for entry in self.equipped}) != len(self.equipped)
                or any(entry.item not in carried or entry.slot not in SLOTS for entry in self.equipped)):
            raise ValueError("Each equipment slot needs a distinct slot and a carried item")
        if len(set(self.combat_loadout)) != len(self.combat_loadout) or set(self.combat_loadout) - carried:
            raise ValueError("Combat loadout must identify distinct carried items")
        for collection in (self.goals, self.needs, self.private_facts):
            if len({entry.id for entry in collection}) != len(collection):
                raise ValueError("Goals, needs and private facts require unique IDs")
        if self.goals and not any(goal.activation == "always" for goal in self.goals):
            raise ValueError("At least one goal must always be available")
        if len(self.goals) > 12 or len(self.needs) > 12 or len(self.private_facts) > 24 or len(self.bonds) > 12 or len(self.combat_loadout) > 8:
            raise ValueError("Character record exceeds its authored collection limits")
        if len({n.item_id for n in self.needs}) != len(self.needs):
            raise ValueError("Personal needs must request distinct items")


@dataclass(frozen=True, slots=True)
class LocationExit:
    direction: str = text(required=True)
    target_page_id: UUID | None = None
    travel_time: int = bounded(0)


@dataclass(frozen=True, slots=True)
class InnerLocation:
    label: str = text(required=True)
    target_page_id: UUID | None = None


@dataclass(frozen=True, slots=True)
class ExtraField:
    key: str = text(required=True)
    value: str = text(limit=2000)


@dataclass(frozen=True, slots=True)
class MapLocation:
    location_id: str = text(required=True, identifier=True, limit=160)
    map_id: UUID | None = None
    x: int | float = bounded(0, -1000, 1000)
    y: int | float = bounded(0, -1000, 1000)
    description: str = text(limit=10000)
    directions: tuple[LocationExit, ...] = ()
    inner_locations: tuple[InnerLocation, ...] = ()
    items: tuple[str, ...] = ()
    extra: tuple[ExtraField, ...] = ()

    def __post_init__(self):
        if len({edge.direction for edge in self.directions}) != len(self.directions) or any(edge.direction not in DIRECTIONS for edge in self.directions):
            raise ValueError("Choose distinct compass directions")
        if len({entry.key for entry in self.extra}) != len(self.extra):
            raise ValueError("Location extra fields require distinct names")


@dataclass(frozen=True, slots=True)
class Money:
    currency: str = text(required=True, identifier=True, limit=80)
    amount: int = bounded(0, 0, 9_000_000_000_000_000)


@dataclass(frozen=True, slots=True)
class Weapon:
    damage_die: int = bounded(4, 4, 12)
    accuracy: int = bounded(0, -3, 3)
    damage_bonus: int = bounded(0, 0, 5)
    stat: Literal["might", "agility", "resolve"] = "might"

    def __post_init__(self):
        if self.damage_die not in {4, 6, 8, 10, 12}:
            raise ValueError("Choose a supported weapon die")


@dataclass(frozen=True, slots=True)
class Armour:
    protection: int = bounded(0, 0, 5)
    evasion_penalty: int = bounded(0, 0, 3)


@dataclass(frozen=True, slots=True)
class Consumable:
    kind: Literal["eat", "drink"] = "eat"
    portions: int = bounded(1, 1, 100)
    empty_name: str | None = None
    empty_description: str = text(limit=10000)

    def __post_init__(self):
        if self.empty_name is not None and not self.empty_name:
            raise ValueError("An empty vessel needs a name, or leave it unset")


@dataclass(frozen=True, slots=True)
class ItemDefinition:
    item_id: str = text(required=True, identifier=True, limit=160)
    item_type: str = text()
    description: str = text(limit=10000)
    value: int | float = bounded(0, 0, 9_000_000_000_000_000)
    weight: int | float = bounded(0, 0, 1000000)
    value_currency: str | None = None
    material: str = text()
    colour: str = text()
    slot: str = text()
    two_handed: bool = False
    level: int = bounded(0)
    contents: str = text()
    unique: bool = False
    portable: bool = False
    pickup_policy: Literal["free", "permission_required"] = "permission_required"
    container_capacity: int = bounded(0, 0, 100)
    wallet_currency: str | None = None
    price: Money | None = None
    consumable: Consumable | None = None
    social_tags: tuple[str, ...] = ()
    weapon: Weapon | None = None
    armour: Armour | None = None
    stats: tuple[Attribute, ...] = ()

    def __post_init__(self):
        if any(value is not None and not value for value in (self.value_currency, self.wallet_currency)):
            raise ValueError("Currency IDs cannot be empty; leave them unset instead")
        if len(self.social_tags) > 7 or set(self.social_tags) - {"poor", "common", "merchant", "noble", "clean", "dirty", "unkempt"}:
            raise ValueError("Choose at most seven supported social tags")
        if len({entry.name for entry in self.stats}) != len(self.stats):
            raise ValueError("Item stat names must be distinct")
        if self.slot and self.slot not in SLOTS:
            raise ValueError("Choose a valid wearable slot")
        if self.weapon and (not self.portable or self.consumable or self.wallet_currency or self.container_capacity or self.slot):
            raise ValueError("Weapons must be portable hand-held items")
        if self.armour and (not self.portable or not self.slot or self.weapon or self.consumable):
            raise ValueError("Armour must be portable wearable equipment")
        if self.consumable and (not self.portable or self.wallet_currency or self.container_capacity):
            raise ValueError("Consumables must be portable goods without money or containers")


@dataclass(frozen=True, slots=True)
class WorldSource:
    collection: Literal["characters", "players", "items", "locations"]
    key: str
    source_hash: str
    projection_json: str = field(metadata={"limit": 100000})
    wiki_title: str
    map_key: str = ""
    edited_fields: tuple[str, ...] = ()

    def __post_init__(self):
        if not re.fullmatch(r"[0-9a-f]{64}", self.source_hash) or len(self.projection_json) > 100000:
            raise ValueError("Invalid imported record source")
        if not isinstance(json.loads(self.projection_json), dict):
            raise ValueError("Invalid imported record projection")


@dataclass(frozen=True, slots=True)
class WorldPage:
    kind: Literal["note", "character", "location", "item"] = "note"
    provenance: Literal["human-authored", "imported"] = "human-authored"
    character: CharacterSheet | None = None
    location: MapLocation | None = None
    item: ItemDefinition | None = None
    source: WorldSource | None = None

    def __post_init__(self):
        if ((self.kind == "character") != (self.character is not None)
                or (self.kind == "location") != (self.location is not None)
                or (self.kind == "item") != (self.item is not None)):
            raise ValueError("Wiki page type must match its structured record")
        if (self.provenance == "imported") != (self.source is not None):
            raise ValueError("Imported records require retained source provenance")


def stamp_authorship(world, title):
    if world.source is None:
        return world
    baseline = json.loads(world.source.projection_json)
    current = record_data(getattr(world, world.kind))
    changed = [key for key in current if current[key] != baseline.get(key)]
    if title != world.source.wiki_title:
        changed.append("name")
    return replace(world, source=replace(world.source, edited_fields=tuple(sorted(changed))))


@dataclass(frozen=True, slots=True)
class WorldMap:
    id: UUID
    title: str = text(required=True, limit=200)
    initial_location: UUID | None = None
    fingal_id: str = text(identifier=True, limit=160)


def validate_world(project):
    maps = {item.id: item for item in project.maps}
    if len(maps) != len(project.maps) or len(project.maps) > 32 or len({item.title.casefold() for item in project.maps}) != len(maps):
        raise ValueError("Maps need distinct identities and names (at most 32)")
    locations = {page.id: page.world.location for page in project.wiki_pages if page.world.location}
    characters = {page.id: page.world.character for page in project.wiki_pages if page.world.character}
    items = {page.id: page.world.item for page in project.wiki_pages if page.world.item}
    for records, key in ((locations, "location_id"), (characters, "character_id"), (items, "item_id")):
        ids = [getattr(record, key) for record in records.values()]
        if len(ids) != len(set(ids)):
            raise ValueError("World record identifiers must be unique")
    source_bundle = project.fingal_source.bundle if project.fingal_source else None
    source_hash = project.fingal_source.digest if project.fingal_source else None
    source_records = {name: {row.get("item_id" if name == "items" else "character_id"): row for row in source_bundle.get(name, [])}
        for name in ("items", "characters", "players")} if source_bundle else {}
    seen_sources = set()
    for page in project.wiki_pages:
        for world in [page.world, *(revision.world for revision in page.revisions)]:
            source = world.source
            if not source:
                continue
            if not project.fingal_source or source.source_hash != source_hash:
                raise ValueError("Imported record must refer to retained Fingal source")
            expected_kind = "location" if source.collection == "locations" else "item" if source.collection == "items" else "character"
            if world.kind != expected_kind:
                raise ValueError("Imported source type does not match its record")
            if source.collection == "locations":
                original = source_bundle.get("maps", {}).get(source.map_key, {}).get("locations", {}).get(source.key)
            else:
                original = source_records[source.collection].get(source.key)
            if not isinstance(original, dict):
                raise ValueError("Imported source record is missing")
        if page.world.source:
            key = (page.world.source.collection, page.world.source.key)
            if key in seen_sources:
                raise ValueError("Imported source cannot belong to two wiki pages")
            seen_sources.add(key)
    occupied = set()
    for page_id, location in locations.items():
        if location.map_id not in maps:
            raise ValueError("Location must belong to an existing map")
        cell = (location.map_id, location.x, location.y)
        if cell in occupied:
            raise ValueError("Another location already occupies that map cell")
        occupied.add(cell)
        for edge in (*location.directions, *location.inner_locations):
            if edge.target_page_id is None or edge.target_page_id not in locations or edge.target_page_id == page_id:
                raise ValueError("Routes must point to another existing location page")
    for world_map in project.maps:
        if world_map.initial_location and (world_map.initial_location not in locations or locations[world_map.initial_location].map_id != world_map.id):
            raise ValueError("A map's initial location must be on that map")
        cells = [record for record in locations.values() if record.map_id == world_map.id]
        if cells and (max(c.x for c in cells) - min(c.x for c in cells) > 60 or max(c.y for c in cells) - min(c.y for c in cells) > 60):
            raise ValueError("Map locations must fit within a 61 by 61 cell area")
    for page_id, character in characters.items():
        if character.home_location and character.home_location not in locations:
            raise ValueError("Starting cell must refer to an existing location page")
        if any(bond.character_page_id not in characters or bond.character_page_id == page_id for bond in character.bonds):
            raise ValueError("Bonds must refer to another character page")
        for fact in character.private_facts:
            if any(identity and identity not in characters for identity in (fact.rightful_owner, fact.culprit)):
                raise ValueError("Witnessed-theft facts must refer to existing character pages")
