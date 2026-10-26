"""Offline lookup of the bundled WordNet-derived MyThes English data."""

from dataclasses import dataclass, asdict
from functools import lru_cache
from pathlib import Path
import re


DATA_PATH = Path(__file__).with_name("data") / "th_en_US_v2.dat"
LOOKUP_TERM = re.compile(r"[^\W\d_]+(?:['’ -][^\W\d_]+)*", re.UNICODE)
RELATION = re.compile(r"^(.*?) \((antonym|generic term|related term|similar term)\)$")


@dataclass(frozen=True)
class ThesaurusTerm:
    text: str
    relation: str = "synonym"


@dataclass(frozen=True)
class ThesaurusSense:
    part_of_speech: str
    terms: tuple[ThesaurusTerm, ...]


@lru_cache(maxsize=1)
def _index(path: Path) -> dict[str, tuple[int, int]]:
    # Only offsets stay in memory; each lookup reads its own file handle so
    # concurrent requests cannot move one another's cursor.
    entries = {}
    with path.open("rb") as source:
        if source.readline().strip() != b"UTF-8":
            raise ValueError("Unsupported thesaurus encoding")
        while line := source.readline():
            word, count = line.decode("utf-8").rstrip("\r\n").rsplit("|", 1)
            count = int(count)
            entries[word.casefold()] = (source.tell(), count)
            for _ in range(count):
                if not source.readline():
                    raise ValueError("Incomplete thesaurus entry")
    return entries


class Thesaurus:
    def __init__(self, path: Path = DATA_PATH):
        self.path = path

    def lookup(self, word: str) -> dict:
        if not isinstance(word, str) or not 1 <= len(word.strip()) <= 80 or not LOOKUP_TERM.fullmatch(word.strip()):
            raise ValueError("Enter a word or short phrase using letters, spaces, apostrophes, or hyphens.")
        word = word.strip().replace("’", "'").casefold()
        entry = _index(self.path).get(word)
        senses = []
        if entry:
            with self.path.open("rb") as source:
                source.seek(entry[0])
                for _ in range(entry[1]):
                    label, *values = source.readline().decode("utf-8").rstrip("\r\n").split("|")
                    terms = []
                    for value in values:
                        match = RELATION.fullmatch(value)
                        term = ThesaurusTerm(*match.groups()) if match else ThesaurusTerm(value)
                        if term.text.casefold() != word and term not in terms:
                            terms.append(term)
                    senses.append(ThesaurusSense(label.strip("()"), tuple(terms)))
        return {"word": word, "senses": [asdict(sense) for sense in senses]}
