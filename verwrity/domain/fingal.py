"""Immutable imported story source, kept separate from authored projections."""

from dataclasses import dataclass
from hashlib import sha256
import json
import math


MAX_FINGAL_BYTES = 8 * 1024 * 1024


def _unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("Duplicate JSON keys in Fingal story")
        value[key] = item
    return value


def read_json(data):
    if isinstance(data, bytes):
        if len(data) > MAX_FINGAL_BYTES:
            raise ValueError("Fingal story exceeds the 8 MB limit")
        try:
            data = data.decode("utf-8-sig")
        except UnicodeError as error:
            raise ValueError("Expected a UTF-8 Fingal story JSON file") from error
    if not isinstance(data, str) or len(data.encode("utf-8")) > MAX_FINGAL_BYTES:
        raise ValueError("Fingal story exceeds the 8 MB limit")
    def invalid_constant(_):
        raise ValueError("Fingal stories require finite JSON numbers")
    try:
        def finite_float(value):
            number = float(value)
            if not math.isfinite(number):
                invalid_constant(value)
            return number
        return json.loads(data, object_pairs_hook=_unique_object, parse_constant=invalid_constant, parse_float=finite_float)
    except (UnicodeError, RecursionError, json.JSONDecodeError) as error:
        raise ValueError("Expected a readable UTF-8 Fingal story JSON file") from error


@dataclass(frozen=True, slots=True)
class FingalSource:
    source_name: str
    json_text: str

    @property
    def digest(self):
        return sha256(self.json_text.encode("utf-8")).hexdigest()

    @property
    def bundle(self):
        return read_json(self.json_text)

    def as_dict(self):
        return {"source_name": self.source_name, "source_hash": self.digest, "bundle": self.bundle}

    @classmethod
    def from_dict(cls, value):
        if not isinstance(value, dict) or set(value) != {"source_name", "source_hash", "bundle"}:
            raise ValueError("Invalid retained Fingal source")
        name = value["source_name"]
        if not isinstance(name, str) or len(name) > 200:
            raise ValueError("Invalid Fingal source name")
        bundle = value["bundle"]
        if (not isinstance(bundle, dict) or type(bundle.get("format")) is not int or bundle["format"] != 1
                or not isinstance(bundle.get("maps"), dict)
                or any(not isinstance(bundle.get(key), list) or any(not isinstance(row, dict) for row in bundle[key])
                       for key in ("items", "characters", "players"))
                or any(not isinstance(row, dict) or not isinstance(row.get("locations"), dict)
                       or any(not isinstance(location, dict) for location in row["locations"].values()) for row in bundle["maps"].values())):
            raise ValueError("Invalid retained Fingal source shape")
        # Hash the canonical retained data so the readable archive can verify it.
        encoded = json.dumps(value["bundle"], ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
        result = cls(name, encoded)
        if value["source_hash"] != result.digest:
            raise ValueError("Retained Fingal source hash does not match its data")
        result.bundle
        return result
