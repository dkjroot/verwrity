"""Human-approved project vocabulary, separate from generated candidates."""
import re


def checked_project_words(value):
    if not isinstance(value, list) or len(value) > 1500:
        raise ValueError("Keep up to 1,500 project words.")
    result, seen = [], set()
    for word in value:
        if not isinstance(word, str) or not word.strip() or len(word) > 100 or any(ord(char) < 32 for char in word):
            raise ValueError("Project words must be non-empty single-line terms of up to 100 characters.")
        word = word.strip()
        if word.casefold() not in seen:
            result.append(word); seen.add(word.casefold())
    return tuple(result)


def known_project_words(project):
    values = [*project.project_words, *sorted(project.spelling_dictionary),
        *(name for page in project.wiki_pages for name in (page.title, *page.aliases) if name.strip() and len(name) <= 100)]
    return list({word.casefold(): word for word in values}.values())


def spelling_terms(project):
    terms = set(known_project_words(project))
    for term in tuple(terms):
        terms.update(re.findall(r"[^\W\d_]+(?:['’‘ʼ＇\-‐‑][^\W\d_]+)*", term))
    return terms
