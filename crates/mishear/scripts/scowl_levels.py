"""Writes data/SCOWL/scowl-levels.tsv (at the repository root): every word
SCOWL lists that CMUdict can pronounce, with its SCOWL size level (10: the
most common words ... 80: rare ones), `word<TAB>level`.

SCOWL (Spell Checker Oriented Word Lists, http://wordlist.aspell.net/, Kevin
Atkinson and others) is under a permissive license that asks for its
copyright notice to travel with the data: data/SCOWL/Copyright.

    curl -sfL -o scowl.tar.gz https://sourceforge.net/projects/wordlist/files/SCOWL/2020.12.07/scowl-2020.12.07.tar.gz/download
    tar -xzf scowl.tar.gz
    python3 scripts/scowl_levels.py scowl-2020.12.07

Kept: common words, contractions, capitalized words (days, months,
nationalities, places, common names) and proper names, in American, British
and common variant spellings, up to level 80. Not kept: abbreviations, and
level 95 (words "likely not in any dictionary"). A word's level is the
lowest it appears at. SCOWL is Latin-1; words with other than ASCII letters
and apostrophes are skipped.
"""

import pathlib
import re
import sys

REGIONS = {"english", "american", "british", "british_z", "variant_1"}
CATEGORIES = {"words", "contractions", "upper", "proper-names"}
MAX_LEVEL = 80
FILE = re.compile(r"(.+?)-(words|contractions|upper|proper-names|abbreviations)\.(\d+)$")
WORD = re.compile(r"[a-z']*[a-z][a-z']*")

scowl = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "scowl-2020.12.07")
root = pathlib.Path(__file__).resolve().parents[3]
out = root / "data" / "SCOWL" / "scowl-levels.tsv"

pronounceable = set()
for line in (root / "data" / "CMUdict" / "cmudict-0.7b").read_text(encoding="latin-1").splitlines():
    if not line.startswith(";;;"):
        pronounceable.add(re.sub(r"\(\d+\)$", "", line.split("  ", 1)[0]).lower())

levels: dict[str, int] = {}
for path in sorted((scowl / "final").iterdir()):
    m = FILE.match(path.name)
    if not m or m.group(1) not in REGIONS or m.group(2) not in CATEGORIES:
        continue
    level = int(m.group(3))
    if level > MAX_LEVEL:
        continue
    for word in path.read_text(encoding="latin-1").splitlines():
        word = word.strip().lower()
        if WORD.fullmatch(word) and word in pronounceable:
            levels[word] = min(levels.get(word, level), level)

out.parent.mkdir(parents=True, exist_ok=True)
out.write_text("".join(f"{w}\t{l}\n" for w, l in sorted(levels.items())))
print(f"wrote {len(levels)} words to {out}")
