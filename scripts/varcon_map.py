"""Writes data/VarCon/varcon-to-american.tsv (at the repository root): every
British, Canadian, Australian or variant spelling VarCon lists, with the
preferred American spelling of the same word ("neighbour's" -> "neighbor's").

VarCon is part of SCOWL (http://wordlist.aspell.net/, Kevin Atkinson and
Benjamin Titze), under a permissive license that asks for its copyright
notice to travel with the data: data/VarCon/LICENSE.

    curl -sfLO https://raw.githubusercontent.com/en-wl/wordlist/master/varcon/varcon.txt
    python3 scripts/varcon_map.py varcon.txt

A spelling is mapped only when it is never itself a preferred American
spelling, and only when every line it appears on agrees on the American
form; the rest are skipped. VarCon is Latin-1.
"""

import pathlib
import re
import sys

WORD = re.compile(r"^[a-z']+$")

source = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "varcon.txt")
out = pathlib.Path(__file__).resolve().parents[1] / "data" / "VarCon" / "varcon-to-american.tsv"

american_words: set[str] = set()
targets: dict[str, set[str]] = {}
for line in source.read_text(encoding="latin-1").splitlines():
    line = line.strip()
    if not line or line.startswith("#"):
        continue
    line = line.split("|", 1)[0]
    american = None
    spellings = []
    for entry in line.split(" / "):
        tags, _, word = entry.partition(":")
        word = word.strip().lower()
        tags = tags.split()
        spellings.append(word)
        # A bare "A" (no variant marker) is the preferred American spelling.
        if "A" in tags:
            american = word
    if american is None:
        continue
    american_words.add(american)
    for word in spellings:
        if word != american:
            targets.setdefault(word, set()).add(american)

rows = []
skipped = 0
for word, americans in sorted(targets.items()):
    if word in american_words or len(americans) != 1 or not WORD.match(word):
        skipped += 1
        continue
    (american,) = americans
    if WORD.match(american):
        rows.append(f"{word}\t{american}\n")

out.parent.mkdir(parents=True, exist_ok=True)
out.write_text("".join(rows))
print(f"wrote {len(rows)} spellings to {out} (skipped {skipped})")
