"""Rebuild the bundled spelling list from checksum-verified local ESDB sources.

Run: python -m scripts.generate_spelling_dictionary SOURCE_DIRECTORY
Source downloads are a separate, explicit maintenance action; this script and
the application never download dictionaries at runtime.
"""

import argparse
from hashlib import sha256
from pathlib import Path

from verwrity.analysis.spelling import WORD_RE


RELEASE = "rel-2026.02.25"
REVISION = "71d7dd07676edb60ade43552e10b41314b7e9287"
BASE_URL = f"https://raw.githubusercontent.com/en-wl/wordlist-diff/{RELEASE}"
LICENCE_SHA256 = "090575a131b4260926c7a6b30a90aca0f5db5fbb5c46778e0c5855227bf6ebc3"
SOURCES = {
    "en_US.txt": "4ff7e0b6d86763e1e042ffd746e94cdf4432618702deac303a1669e2a838db04",
    "en_GB-ise.txt": "82b22843c9958a1efac291e0ea7dbef22ce227dd4e5ca0fd84043cbc62e0a4f1",
    "en_GB-ize.txt": "3ba9391531797b64bf48864f0921de2277596aee06c81e0c44118890338218f7",
    "en_CA.txt": "905b1b6b0a98fcb3701c9c59290a090a4d6ab9127809017fefacbe9c2c6f15a4",
    "en_AU.txt": "d115ebf51c6dcd819c8624019b762c59e185a5c875b97247e5ad2d3d8efe6c1d",
}
# These valid entries from Verwrity's previous SCOWL list fall outside the new
# standard lists. Preserve them so this update does not regress old projects.
COMPATIBILITY_WORDS = {"kiev", "reactance", "trabecula"}
DEFAULT_OUTPUT = Path(__file__).resolve().parents[1] / "verwrity" / "analysis" / "data"


def generated_files(source_directory: Path) -> dict[str, bytes]:
    words = set()
    for name, expected in SOURCES.items():
        data = (source_directory / name).read_bytes()
        if sha256(data).hexdigest() != expected:
            raise ValueError(f"Source checksum mismatch: {name}")
        words.update(word.replace("’", "'").casefold()
                     for word in data.decode("utf-8").splitlines()
                     if WORD_RE.fullmatch(word))
    # The checker already recognizes possessives of every known base form.
    # Keep contractions/other entries when their stripped base is absent.
    words = {word for word in words if not (word.endswith("'s") and word[:-2] in words)}
    words.update(COMPATIBILITY_WORDS)
    output = ("\n".join(sorted(words)) + "\n").encode("utf-8")
    licence = (source_directory / "Copyright").read_bytes()
    if sha256(licence).hexdigest() != LICENCE_SHA256:
        raise ValueError("Source checksum mismatch: Copyright")
    provenance = (
        "Verwrity English spelling word list\n"
        f"Upstream: English Speller Database (ESDB, formerly SCOWLv2) {RELEASE}\n"
        f"Generated-output repository revision: {REVISION}\n"
        "Source: https://wordlist.aspell.net/dicts/\n"
        "Retrieved: 2026-10-03\n"
        "Vocabulary level: standard size 60; US, GB (-ise and -ize), CA, AU.\n"
        "Policy: recognize these dialects together; spelling does not enforce dialect consistency.\n"
        "Do not merge WordNet or the size-70/80/95 lexicons into this default.\n"
        "Larger lexicons admit more rare words that can conceal ordinary typing mistakes.\n"
        "Normalization: retain complete tokenizable entries; normalize apostrophes,\n"
        "casefold, deduplicate, omit redundant possessives, sort, UTF-8 with LF.\n"
        "Compatibility entries retained from the previous SCOWL list: kiev, reactance, trabecula.\n"
        "Previous source: https://github.com/ArmiKorhonen/SCOWL-wordlist\n"
        f"Generated entries: {len(words)}\n"
        f"Generated SHA-256: {sha256(output).hexdigest()}\n\n"
        "Input files and SHA-256:\n"
        + "".join(f"{BASE_URL}/{name}\n  {digest}\n" for name, digest in SOURCES.items())
        + f"{BASE_URL}/Copyright\n  {LICENCE_SHA256}\n"
        + "\nFull upstream permission, attribution and disclaimers: SCOWL_LICENSE.txt.\n"
        "The generated list permits commercial use and remains application analysis data.\n"
        "User/project dictionaries and manuscript data are independent.\n\n"
        "Rebuild: download the input files above and Copyright from the same release\n"
        "into a local source directory, then run:\n"
        "  python -m scripts.generate_spelling_dictionary SOURCE_DIRECTORY\n"
        "Add --check to verify a rebuild without changing bundled files.\n"
        "No network requests occur in the generator or during spelling analysis.\n"
    ).encode("utf-8")
    return {"english_words.txt": output, "SCOWL_LICENSE.txt": licence, "SPELLING_SOURCE.txt": provenance}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source_directory", type=Path)
    parser.add_argument("--output-directory", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    generated = generated_files(args.source_directory)
    for name, data in generated.items():
        if args.check:
            if (args.output_directory / name).read_bytes() != data:
                raise SystemExit(f"Bundled file differs from its sources: {name}")
        else:
            args.output_directory.mkdir(parents=True, exist_ok=True)
            (args.output_directory / name).write_bytes(data)
    print("Verified spelling dictionary." if args.check else "Generated spelling dictionary.")


if __name__ == "__main__":
    main()
