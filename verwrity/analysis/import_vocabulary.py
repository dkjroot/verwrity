"""Local vocabulary discovery for author-reviewed OCR and dictation imports."""
from dataclasses import dataclass, field, asdict
from difflib import SequenceMatcher
import re

from verwrity.ai.dictate_draft import vocabulary
from verwrity.domain.project_words import known_project_words, checked_project_words, spelling_terms
from verwrity.analysis.spelling import WORD_RE, normalize_word

MAX_SCAN = 2_000_000
MAX_CANDIDATES = 1500
WORDS = WORD_RE


def project_terms(project):
    return sorted(known_project_words(project), key=str.casefold)


@dataclass
class Candidate:
    term: str
    sources: dict[str, int] = field(default_factory=dict)
    examples: list[str] = field(default_factory=list)
    known: bool = False


def discover(project, sections, selected, checker, user_words=()):
    selected = checked_project_words(selected)
    if not isinstance(sections, list) or len(sections) > 500 or any(not isinstance(text, str) or len(text) > 20000 for text in sections):
        raise ValueError("Scan up to 500 raw sections of 20,000 characters each.")
    scenes = [scene for scene in project.scenes if not scene.historical]
    if sum(len(scene.text) for scene in scenes) + sum(map(len, sections)) > MAX_SCAN:
        raise ValueError("Vocabulary scan exceeds two million characters. Split the import; no text was sampled.")
    found = {}
    def add(term, source, example="", known=False):
        term = term.strip()
        if not term or len(term) > 100:
            return
        key = normalize_word(term)
        if key not in found and len(found) >= MAX_CANDIDATES:
            raise ValueError("More than 1,500 vocabulary candidates. Split the import or refine the source before scanning; no partial list was returned.")
        item = found.setdefault(key, Candidate(term))
        item.known |= known
        item.sources[source] = item.sources.get(source, 0) + 1
        if example and len(item.examples) < 2 and example not in item.examples:
            item.examples.append(example)
    for term in selected:
        add(term, "Selected vocabulary")
    for term in sorted(project.spelling_dictionary):
        add(term, "Project dictionary", known=True)
    for term in project.project_words:
        add(term, "Project words", known=True)
    for term in sorted(user_words):
        add(term, "User dictionary", known=True)
    for page in project.wiki_pages:
        for index, term in enumerate((page.title, *page.aliases)):
            add(term, "Wiki title" if index == 0 else "Wiki alias", known=True)
    correct = {}
    known = spelling_terms(project) | set(user_words) | set(selected)
    def scan(text, source):
        for match in WORDS.finditer(text):
            term = match.group()
            if len(term) < 2 or not any(char.isalpha() for char in term):
                continue
            key = normalize_word(term)
            if key not in correct:
                correct[key] = checker.is_correct(term, known)
            if key in found or not correct[key]:
                add(term, source, text[max(0, match.start() - 35):match.end() + 35].replace("\n", " "))
    for scene in scenes:
        scan(scene.text, "Saved manuscript")
    for index, text in enumerate(sections):
        scan(text, f"Import section {index + 1}")
    # Similarity is a display aid only. It never selects a spelling or replaces
    # source text. Compare against one group representative to avoid fuzzy chains.
    groups = []
    for item in sorted(found.values(), key=lambda c: (not c.known, c.term.casefold())):
        key = item.term.casefold()
        match = None
        for group in groups:
            reference = group[0].term.casefold()
            if min(len(key), len(reference)) >= 4 and abs(len(key) - len(reference)) <= 2 and SequenceMatcher(None, key, reference).ratio() >= .78:
                match = group
                break
        if match is None:
            groups.append([item])
        else:
            match.append(item)
    return {"groups": [[asdict(item) for item in group] for group in groups], "count": len(found),
        "section_count": len(sections), "manuscript_scenes": len(scenes)}
