"""Reviewed format-1 story adaptation; no Fingal runtime or catalogue I/O.

The retained source is immutable. Only fields changed from the imported typed
projection overlay it on export, preserving extensions and omitted defaults.
"""

from copy import deepcopy
from dataclasses import fields, is_dataclass, replace
import json
from pathlib import PurePath
import re
from types import UnionType
from typing import get_args, get_origin, get_type_hints
from uuid import uuid4, uuid5

from verwrity.domain.fingal import FingalSource, read_json, MAX_FINGAL_BYTES
from verwrity.domain.project_features import ProjectFeatures
from verwrity.domain.story import StoryProject, WikiPage
from verwrity.domain.world import (CharacterSheet, ItemDefinition, MapLocation, WorldMap,
    WorldPage, WorldSource, DIRECTIONS, read_record, record_data, validate_world)


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _objects(value, label):
    if not isinstance(value, list) or len(value) > 10000 or any(not isinstance(v, dict) for v in value):
        raise ValueError(f"{label} must be an array of records (at most 10000)")
    return value


def _name(value, label):
    if not isinstance(value, str) or not value.strip() or len(value) > 200:
        raise ValueError(f"{label} needs a nonempty name up to 200 characters")
    return value


def _known(model, values):
    """Project known fields without promoting extension data to author text."""
    if not isinstance(values, dict):
        raise ValueError("Expected structured record fields")
    if model.__name__ == "CombatProfile" and "hostile" in values:
        if type(values["hostile"]) is not bool:
            raise ValueError("Legacy combat hostility must be a boolean")
        values = {key: value for key, value in values.items() if key != "hostile"}
    result = {}
    hints = get_type_hints(model)
    if model.__name__ not in {"CharacterSheet", "MapLocation", "ItemDefinition", "InventoryItem", "EquippedItem", "Attribute"} and values.keys() - hints.keys():
        raise ValueError(f"Unknown fields in {model.__name__}")
    for field in fields(model):
        if field.name not in values:
            continue
        value, hint = values[field.name], hints[field.name]
        if get_origin(hint) is UnionType and type(None) in get_args(hint):
            hint = next(arg for arg in get_args(hint) if arg is not type(None))
        if is_dataclass(hint) and value is not None:
            value = _known(hint, value)
        elif get_origin(hint) is tuple and is_dataclass(get_args(hint)[0]):
            value = [_known(get_args(hint)[0], row) for row in _objects(value, field.name)]
        result[field.name] = value
    return result


def _projection(collection, raw, locations, characters, map_id=None, identity=None):
    data = deepcopy(raw)
    if collection in {"characters", "players"}:
        model = CharacterSheet
        data["player_template"] = collection == "players"
        data["home_location"] = locations.get(raw.get("home_location"))
        if raw.get("home_location") and data["home_location"] is None:
            raise ValueError("Character starting location does not exist")
        data["bonds"] = [{"character_page_id": characters.get(key), "kind": value} for key, value in raw.get("bonds", {}).items()]
        data["private_facts"] = [dict(fact, rightful_owner=characters.get(fact.get("rightful_owner")),
            culprit=characters.get(fact.get("culprit")), stolen_item=fact.get("stolen_item") or "") for fact in raw.get("private_facts", [])]
        if raw.get("social_profile") is not None:
            social = data["social_profile"]
            social["appearance_preferences"] = [{"tag": k, "value": v} for k, v in social.get("appearance_preferences", {}).items()]
            social["approach_preferences"] = [{"approach": k, "response": v} for k, v in social.get("approach_preferences", {}).items()]
        for need in data.get("needs", []):
            need["reward_money_max"] = [{"currency": k, "maximum": v} for k, v in need.get("reward_money_max", {}).items()]
        data["attributes"] = [{"name": row["name"], "value": str(row.get("value", ""))}
            for row in raw.get("attributes", []) if isinstance(row, dict) and isinstance(row.get("name"), str)]
        if isinstance(data.get("combat"), dict):
            data["combat"].setdefault("skills", ["second_wind"])
        for entry in data.get("inventory", []):
            entry["mount"] = entry.get("mount") or ""
    elif collection == "items":
        model = ItemDefinition
        data["stats"] = [{"name": k, "value": str(v)} for k, v in raw.get("stats", {}).items()]
    else:
        model = MapLocation
        data.update(map_id=map_id, location_id=identity)
        data["directions"] = [{"direction": edge["direction"], "target_page_id": locations.get(edge["next_location_id"]),
            "travel_time": edge["travel_time"]} for edge in raw.get("directions", []) if edge["next_location_id"]]
        data["inner_locations"] = [{"label": edge.get("label") or edge.get("name") or "Enter",
            "target_page_id": locations.get(edge.get("target_location_id", edge.get("target")))}
            for edge in raw.get("inner_locations", []) if edge.get("target_location_id", edge.get("target"))]
        data["extra"] = [{"key": k, "value": str(v)} for k, v in raw.get("extra", {}).items() if isinstance(v, str)]
    return read_record(model, _known(model, data))


def validate_bundle(bundle):
    try:
        return _validate_bundle(bundle)
    except (KeyError, TypeError, AttributeError, RecursionError, OverflowError) as error:
        raise ValueError("Invalid Fingal story field shape or excessive nesting") from error


def _validate_bundle(bundle):
    """Validate local adapter shape, identities and references before adaptation."""
    if (not isinstance(bundle, dict) or set(bundle) - {"economy"} != {"format", "maps", "characters", "items", "players"}
            or type(bundle["format"]) is not int or bundle["format"] != 1):
        raise ValueError("Expected a format-1 Fingal story with maps, characters, items and players")
    if len(canonical(bundle).encode()) > MAX_FINGAL_BYTES:
        raise ValueError("Fingal story exceeds the 8 MB limit")
    ids = {}
    for collection in ("characters", "players", "items"):
        key = "item_id" if collection == "items" else "character_id"
        ids[collection] = {}
        for record in _objects(bundle[collection], collection):
            identity = record.get(key)
            _name(record.get("name"), collection)
            if not isinstance(identity, str) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,160}", identity) or identity in ids[collection]:
                raise ValueError(f"Invalid or duplicate {collection} ID")
            ids[collection][identity] = record
    if ids["characters"].keys() & ids["players"].keys():
        raise ValueError("NPC and player character IDs must be distinct")
    maps = bundle["maps"]
    if not isinstance(maps, dict) or not 1 <= len(maps) <= 32 or len({k.casefold() for k in maps}) != len(maps):
        raise ValueError("Fingal requires between one and 32 distinctly named maps")
    locations = {}
    for key, world_map in maps.items():
        if (not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,159}", key) or key.lower().startswith(("sqlite_", "_fingal", "fingal_"))
                or key.lower() == "maps_index"):
            raise ValueError("Fingal map IDs use letters, numbers and underscores and cannot be reserved names")
        if not isinstance(world_map, dict) or not isinstance(world_map.get("locations"), dict) or not world_map["locations"]:
            raise ValueError("Every Fingal map needs locations")
        if world_map.get("initial_location_id") not in world_map["locations"]:
            raise ValueError("Every Fingal map needs an initial location on that map")
        for identity, record in world_map["locations"].items():
            if not re.fullmatch(re.escape(key) + r"\.[A-Za-z0-9_.-]+", identity) or identity in locations or not isinstance(record, dict):
                raise ValueError("Location IDs must be unique and prefixed by their map ID and a dot")
            _name(record.get("name"), "Location")
            locations[identity] = record
    for record in locations.values():
        for field in ("directions", "inner_locations"):
            for edge in _objects(record.get(field, []), field):
                target = edge.get("next_location_id") if field == "directions" else edge.get("target_location_id", edge.get("target", ""))
                if not isinstance(target, str) or (target and target not in locations):
                    raise ValueError("Location route points to an unknown location")
                if field == "directions" and (edge.get("direction") not in DIRECTIONS or type(edge.get("travel_time")) is not int or edge["travel_time"] < 0):
                    raise ValueError("Invalid compass route or travel time")
        if not isinstance(record.get("extra", {}), dict):
            raise ValueError("Location extra fields must be an object")
    people = {**ids["characters"], **ids["players"]}
    items = ids["items"]
    currencies = _economy(bundle.get("economy", {}))
    def item_ref(key):
        if key not in items:
            raise ValueError(f"Missing item definition: {key}")
    def money_ref(value):
        if (not isinstance(value, dict) or set(value) != {"currency", "amount"} or value["currency"] not in currencies
                or type(value["amount"]) is not int or not 0 <= value["amount"] <= 9_000_000_000_000_000):
            raise ValueError("Invalid money or unknown currency")
    for item in items.values():
        for field in ("wallet_currency", "value_currency"):
            if item.get(field) and item[field] not in currencies:
                raise ValueError("Item refers to an unknown currency")
        if item.get("price") is not None:
            money_ref(item["price"])
        if not isinstance(item.get("stats", {}), dict):
            raise ValueError("Item stats must be an object")
        for value in item.get("stats", {}).values():
            try:
                canonical(float(value))
            except (ValueError, TypeError):
                raise ValueError("Item stat values must be finite numbers") from None
    for record in locations.values():
        if not isinstance(record.get("items", []), list):
            raise ValueError("Location items must be an array")
        for item in record.get("items", []):
            item_ref(item)
    for identity, person in people.items():
        if "age" in person and type(person["age"]) is not int:
            raise ValueError("Character age must be a whole number")
        if "behaviour" in person and not isinstance(person["behaviour"], dict):
            raise ValueError("Character behaviour must be an object")
        for target in person.get("bonds", {}):
            if target == identity or target not in people:
                raise ValueError("Character bond points to an unknown character or itself")
        for entry in _objects(person.get("inventory", []), "Inventory"):
            item_ref(entry.get("item"))
            if "money_balance" in entry and (type(entry["money_balance"]) is not int or not 0 <= entry["money_balance"] <= 9_000_000_000_000_000):
                raise ValueError("Starting purse balance needs a nonnegative whole amount")
            overrides = entry.get("overrides", {})
            if not isinstance(overrides, dict) or overrides.keys() - {"name", "description", "social_tags", "stats"}:
                raise ValueError("Invalid individual item overrides")
            if entry.get("money_balance") is not None and not items[entry["item"]].get("wallet_currency"):
                raise ValueError("A starting money balance needs a wallet item")
        for need in _objects(person.get("needs", []), "Personal needs"):
            for item in [need.get("item_id"), *need.get("reward_items", []), *need.get("guaranteed_items", [])]:
                item_ref(item)
            requested = items[need["item_id"]]
            if not requested.get("unique", False) or not requested.get("portable", False):
                raise ValueError("A return need requires a unique portable item")
            if any(not items[key].get("portable", False) or items[key].get("wallet_currency") for key in [*need.get("reward_items", []), *need.get("guaranteed_items", [])]):
                raise ValueError("Personal need rewards must be portable goods without purse balances")
            if set(need.get("guaranteed_items", [])) - {entry["item"] for entry in person.get("inventory", [])}:
                raise ValueError("Guaranteed rewards must be carried by their giver")
            if any(key not in currencies for key in need.get("reward_money_max", {})):
                raise ValueError("Personal need refers to an unknown currency")
        for fact in _objects(person.get("private_facts", []), "Private facts"):
            if fact.get("stolen_item"):
                item_ref(fact["stolen_item"])
                if fact.get("rightful_owner") not in people or fact.get("culprit") not in people:
                    raise ValueError("Witnessed theft refers to an unknown character")
        for offer in _objects(person.get("sale_offers", []), "Vendor offers"):
            item_ref(offer.get("item_id")); money_ref(offer.get("price"))
            definition = items[offer["item_id"]]
            if not definition.get("portable", False) or definition.get("unique", False) or definition.get("wallet_currency"):
                raise ValueError("Vendor stock must use portable non-unique goods without purse balances")
    for location in locations.values():
        for offer in _objects(location.get("services", []), "Location services"):
            money_ref(offer.get("price"))
    # Each player template is an alternative starting world, not a simultaneous
    # second copy of every player-owned unique item.
    fixed = [(key, 1) for location in locations.values() for key in location.get("items", [])]
    fixed += [(entry["item"], entry.get("quantity", 1)) for person in bundle["characters"] for entry in person.get("inventory", [])]
    for player in bundle["players"] or [{}]:
        seen = set()
        for key, quantity in fixed + [(entry["item"], entry.get("quantity", 1)) for entry in player.get("inventory", [])]:
            definition = items[key]
            if definition.get("unique", False) and (key in seen or quantity != 1):
                raise ValueError("A unique item can have only one starting copy per player template")
            if definition.get("wallet_currency") and quantity != 1:
                raise ValueError("Each starting purse needs one physical identity")
            if (definition.get("consumable") or {}).get("empty_name") and quantity != 1:
                raise ValueError("Reusable vessels need separate starting identities")
            seen.add(key)
    # Run the same typed forms used by authoring, including nested bounds.
    location_refs = {key: uuid4() for key in locations}
    character_refs = {key: uuid4() for key in people}
    for collection in ("characters", "players", "items"):
        for raw in bundle[collection]:
            _projection(collection, raw, location_refs, character_refs)
    for identity, raw in locations.items():
        _projection("locations", raw, location_refs, character_refs, uuid4(), identity)
    return bundle


def _economy(economy):
    if not isinstance(economy, dict):
        raise ValueError("Economy must be an object")
    currencies = {}
    rows = _objects(economy.get("currencies", []), "Currencies")
    if len(rows) > 20:
        raise ValueError("Use at most 20 currencies")
    for row in rows:
        if set(row) != {"id", "name", "denominations"}:
            raise ValueError("Currency definitions need ID, name and denominations")
        key = row.get("id")
        if not isinstance(key, str) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,80}", key) or key in currencies:
            raise ValueError("Invalid or duplicate currency")
        _name(row.get("name"), "Currency")
        denominations = _objects(row.get("denominations"), "Denominations")
        if not 1 <= len(denominations) <= 12:
            raise ValueError("Currency needs one to 12 denominations")
        previous, names = 0, set()
        for denomination in denominations:
            if set(denomination) != {"name", "units"}:
                raise ValueError("A denomination needs a name and units")
            units, name = denomination.get("units"), _name(denomination.get("name"), "Denomination")
            if (type(units) is not int or not 1 <= units <= 9_000_000_000_000_000 or (not previous and units != 1)
                    or (previous and (units <= previous or units % previous)) or name.casefold() in names):
                raise ValueError("Denominations must start at one and increase by whole multiples")
            previous = units; names.add(name.casefold())
        currencies[key] = row
    seen = set()
    references = _objects(economy.get("reference_prices", []), "Reference prices")
    if len(references) > 200:
        raise ValueError("Use at most 200 reference prices")
    for row in references:
        key, price = row.get("id"), row.get("price", {})
        if (not isinstance(key, str) or not key or key in seen or not isinstance(price, dict)
                or price.get("currency") not in currencies or type(price.get("amount")) is not int
                or not 0 <= price["amount"] <= 9_000_000_000_000_000):
            raise ValueError("Invalid reference price")
        seen.add(key)
    return currencies


def import_story(data, filename="Fingal story.json", project_id=None):
    bundle = validate_bundle(read_json(data))
    filename = PurePath(filename.replace("\\", "/")).name[:200]
    title = filename.removesuffix(".json").removesuffix(".fingal") or "Imported Fingal world"
    source = FingalSource(filename, canonical(bundle))
    project = StoryProject(title, project_id=project_id or uuid4(), features=ProjectFeatures(fingal_mode=True), fingal_source=source)
    locations = {key: uuid5(project.project_id, "location:" + key) for m in bundle["maps"].values() for key in m["locations"]}
    characters = {raw["character_id"]: uuid5(project.project_id, "character:" + raw["character_id"])
        for name in ("characters", "players") for raw in bundle[name]}
    used_titles = set()
    def page(collection, key, raw, map_key="", map_id=None):
        kind = "location" if collection == "locations" else "item" if collection == "items" else "character"
        title = raw["name"].strip()
        if title.casefold() in used_titles:
            title = (title[:160] + " · " + key)[:200]
        while title.casefold() in used_titles:
            title = title[:190] + " " + uuid4().hex[:8]
        used_titles.add(title.casefold())
        record = _projection(collection, raw, locations, characters, map_id, key)
        provenance = WorldSource(collection, key, source.digest, canonical(record_data(record)), title, map_key)
        world = WorldPage(kind=kind, provenance="imported", source=provenance, **{kind: record})
        identity = locations[key] if kind == "location" else characters[key] if kind == "character" else uuid5(project.project_id, "item:" + key)
        project.wiki_pages.append(WikiPage(identity, title, world=world))
    for key, raw_map in bundle["maps"].items():
        identity = uuid5(project.project_id, "map:" + key)
        project.maps.append(WorldMap(identity, key, locations[raw_map["initial_location_id"]], key))
        for location_key, raw in raw_map["locations"].items():
            page("locations", location_key, raw, key, identity)
    for name in ("characters", "players", "items"):
        for raw in bundle[name]:
            page(name, raw["item_id" if name == "items" else "character_id"] , raw)
    validate_world(project)
    return project


def _merge(base, value):
    """Preserve nested extensions by stable authored identity on edited fields."""
    if isinstance(base, dict) and isinstance(value, dict):
        dynamic = {"appearance_preferences", "approach_preferences", "reward_money_max"}
        return {**deepcopy(base), **{key: deepcopy(item) if key in dynamic else _merge(base.get(key), item) for key, item in value.items()}}
    if isinstance(base, list) and isinstance(value, list) and all(isinstance(v, dict) for v in value):
        identity = next((key for key in ("id", "item", "direction", "name", "label") if value and all(key in v for v in value)), None)
        if identity:
            return [_merge(next((old for old in base if isinstance(old, dict) and old.get(identity) == row[identity]), {}), row) for row in value]
    return deepcopy(value)


def export_story(project):
    validate_world(project)
    original = project.fingal_source.bundle if project.fingal_source else {}
    bundle = {"format": 1, "maps": {}, "characters": [], "players": [], "items": []}
    if "economy" in original:
        bundle["economy"] = deepcopy(original["economy"])
    locations = {p.id: p for p in project.wiki_pages if p.world.location}
    characters = {p.id: p for p in project.wiki_pages if p.world.character}
    map_ids, location_ids, character_ids, item_ids, mapping = {}, {}, {}, {}, []
    for world_map in project.maps:
        key = world_map.fingal_id or re.sub(r"[^A-Za-z0-9_]", "_", world_map.title)
        if not key or not re.match(r"[A-Za-z_]", key):
            key = "map_" + key
        if key in map_ids.values():
            raise ValueError("Export map IDs collide; rename the maps")
        map_ids[world_map.id] = key
    for page in locations.values():
        record = page.world.location
        prefix, separator, suffix = record.location_id.partition(".")
        known_maps = set(map_ids.values()) | set(original.get("maps", {}))
        native_id = map_ids[record.map_id] + "." + (suffix if separator and prefix in known_maps else record.location_id)
        location_ids[page.id] = native_id
        if record.location_id != native_id:
            mapping.append(f"{page.title}: {record.location_id} → {native_id}")
    if len(set(location_ids.values())) != len(location_ids):
        raise ValueError("Location IDs collide after map prefixes are applied; edit their Fingal location IDs")
    character_ids = {key: page.world.character.character_id for key, page in characters.items()}
    item_ids = {p.id: p.world.item.item_id for p in project.wiki_pages if p.world.item}
    remaps = {"locations": {}, "characters": {}, "items": {}}
    for page in project.wiki_pages:
        source = page.world.source
        if source:
            group = "characters" if source.collection == "players" else source.collection
            remaps[group][source.key] = (location_ids if group == "locations" else character_ids if group == "characters" else item_ids)[page.id]
    if original:
        # Remap retained references once, before typed UUID references overlay them.
        # Doing this afterwards would corrupt swaps of two authored IDs.
        _remap_references(original, remaps)
    for world_map in project.maps:
        key = map_ids[world_map.id]
        raw = deepcopy(original.get("maps", {}).get(world_map.fingal_id, {}))
        raw.update(initial_location_id=location_ids.get(world_map.initial_location, ""), locations={})
        bundle["maps"][key] = raw
    for page in project.wiki_pages:
        world, source = page.world, page.world.source
        if world.kind == "note":
            continue
        kind = world.kind
        record = record_data(getattr(world, kind))
        baseline = json.loads(source.projection_json) if source else {}
        if source:
            raw = (original["maps"][source.map_key]["locations"][source.key] if source.collection == "locations" else
                next(row for row in original[source.collection] if row.get("item_id" if kind == "item" else "character_id") == source.key))
            raw = deepcopy(raw)
        else:
            raw = {}
        if not source or page.title != source.wiki_title:
            raw["name"] = page.title
        for field, value in record.items():
            if source and value == baseline.get(field):
                continue
            if field in {"map_id", "location_id", "player_template"}:
                continue
            if value is None and field in {"age", "behaviour"}:
                raw.pop(field, None)
                continue
            if field == "home_location":
                value = location_ids.get(getattr(world.character, field), "")
            elif field == "bonds":
                value = {character_ids[entry.character_page_id]: entry.kind for entry in world.character.bonds}
            elif field == "private_facts":
                value = [{**fact, "rightful_owner": character_ids.get(entry.rightful_owner), "culprit": character_ids.get(entry.culprit),
                    "stolen_item": entry.stolen_item or None} for fact, entry in zip(value, world.character.private_facts)]
            elif field == "social_profile" and value is not None:
                value["appearance_preferences"] = {entry["tag"]: entry["value"] for entry in value["appearance_preferences"]}
                value["approach_preferences"] = {entry["approach"]: entry["response"] for entry in value["approach_preferences"]}
            elif field == "needs":
                for need in value:
                    need["reward_money_max"] = {r["currency"]: r["maximum"] for r in need["reward_money_max"]}
            elif field == "directions":
                value = [{"direction": edge.direction, "next_location_id": location_ids[edge.target_page_id], "travel_time": edge.travel_time} for edge in world.location.directions]
                # Empty compass entries are source metadata until explicitly replaced by a route.
                value += [deepcopy(edge) for edge in raw.get(field, []) if not edge["next_location_id"] and edge["direction"] not in {v["direction"] for v in value}]
            elif field == "inner_locations":
                value = [{"label": edge.label, "target_location_id": location_ids[edge.target_page_id]} for edge in world.location.inner_locations]
            elif field == "extra":
                # Editable strings coexist with retained nested extension objects.
                value = {**{k: v for k, v in raw.get("extra", {}).items() if not isinstance(v, str)}, **{r["key"]: r["value"] for r in value}}
                raw[field] = value; continue
            elif field == "stats":
                try:
                    value = {r["name"]: float(r["value"]) for r in value}
                except ValueError as error:
                    raise ValueError("Item stats need numeric values") from error
            elif field == "attributes":
                old_rows = raw.get(field, [])
                value = _merge(old_rows, value)
                for row in value:
                    old = next((r for r in old_rows if r.get("name") == row["name"]), None)
                    if old and str(old.get("value", "")) == row["value"]:
                        row["value"] = old.get("value", "")
                value += [deepcopy(row) for row in old_rows if not isinstance(row.get("name"), str)]
                raw[field] = value; continue
            elif field == "inventory":
                value = [{k: v for k, v in entry.items() if v is not None} for entry in value]
                for entry in value:
                    for key in ("item", "mount"):
                        if entry.get(key) and entry[key] not in item_ids.values():
                            entry[key] = remaps["items"].get(entry[key], entry[key])
                value = _merge(raw.get(field), value)
                for entry, current in zip(value, world.character.inventory):
                    if current.money_balance is None:
                        entry.pop("money_balance", None)
                raw[field] = value; continue
            if field in {"bonds", "stats"}:
                raw[field] = value
            else:
                raw[field] = _merge(raw.get(field), value)
        if kind == "location":
            bundle["maps"][map_ids[world.location.map_id]]["locations"][location_ids[page.id]] = raw
        else:
            raw["item_id" if kind == "item" else "character_id"] = (item_ids if kind == "item" else character_ids)[page.id]
            bundle["items" if kind == "item" else "players" if world.character.player_template else "characters"].append(raw)
    validate_bundle(bundle)
    return bundle, mapping


def _remap_references(bundle, remaps):
    def remap(group, value):
        return remaps[group].get(value, value)
    for world_map in bundle["maps"].values():
        for location in world_map["locations"].values():
            for edge in location.get("directions", []):
                edge["next_location_id"] = remap("locations", edge["next_location_id"])
            for edge in location.get("inner_locations", []):
                for key in ("target_location_id", "target"):
                    if key in edge:
                        edge[key] = remap("locations", edge[key])
            if "items" in location:
                location["items"] = [remap("items", key) for key in location["items"]]
    for person in [*bundle["characters"], *bundle["players"]]:
        if "home_location" in person:
            person["home_location"] = remap("locations", person["home_location"])
        if "bonds" in person:
            person["bonds"] = {remap("characters", key): value for key, value in person["bonds"].items()}
        for entry in [*person.get("inventory", []), *person.get("equipped", [])]:
            entry["item"] = remap("items", entry["item"])
            if entry.get("mount"):
                entry["mount"] = remap("items", entry["mount"])
        if "combat_loadout" in person:
            person["combat_loadout"] = [remap("items", key) for key in person["combat_loadout"]]
        for fact in person.get("private_facts", []):
            for key in ("rightful_owner", "culprit"):
                if key in fact:
                    fact[key] = remap("characters", fact[key])
            if fact.get("stolen_item"):
                fact["stolen_item"] = remap("items", fact["stolen_item"])
        for need in person.get("needs", []):
            need["item_id"] = remap("items", need["item_id"])
            for key in ("reward_items", "guaranteed_items"):
                if key in need:
                    need[key] = [remap("items", value) for value in need[key]]
        for offer in person.get("sale_offers", []):
            offer["item_id"] = remap("items", offer["item_id"])


def review(project):
    counts = {kind: sum(p.world.kind == kind for p in project.wiki_pages) for kind in ("character", "location", "item")}
    counts["maps"] = len(project.maps)
    counts["players"] = sum(bool(p.world.character and p.world.character.player_template) for p in project.wiki_pages)
    warnings = ["Manuscript scenes and wiki prose stay in the Verwrity archive; they are not included in the Fingal game file."]
    if project.fingal_source:
        warnings.append("Original source and extension fields are retained. Economy and unsupported extension data are preserved from the imported file.")
    errors, mapping = [], []
    try:
        _, mapping = export_story(project)
    except (ValueError, KeyError, TypeError) as error:
        errors.append(str(error) if isinstance(error, ValueError) else "A retained field has an invalid shape; review the source file.")
    if not counts["players"]:
        errors.append("Mark at least one character sheet as a player template before exporting a playable story.")
    return {"title": project.title, "counts": counts, "warnings": warnings, "errors": errors, "mapping": mapping}
