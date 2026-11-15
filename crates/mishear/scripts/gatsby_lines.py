"""Writes data/gatsby/lines.txt (at the repository root): line-sized pieces
of F. Scott Fitzgerald's The Great Gatsby (1925; public domain), for the web
page's "random line". A piece is a sentence of 5 to 14 words, or, from a
longer sentence, a clause of that length (split at commas, semicolons,
colons and dashes); only pieces whose every word CMUdict lists are kept, so
a random line is always heard.

    curl -sfLO https://www.gutenberg.org/cache/epub/64317/pg64317.txt
    python3 scripts/gatsby_lines.py pg64317.txt

The text is Project Gutenberg's ebook #64317, its header, license and
contents left out.
"""

import pathlib
import re
import sys

MIN_WORDS, MAX_WORDS = 5, 14

source = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "pg64317.txt")
root = pathlib.Path(__file__).resolve().parents[3]
out = root / "data" / "gatsby" / "lines.txt"

text = source.read_text(encoding="utf-8")
text = text.split("*** END OF THE PROJECT GUTENBERG EBOOK")[0]
# The novel starts at chapter I, after the title, contents, dedication and
# epigraph.
text = re.split(r"\n\s+I\n\n", text, maxsplit=1)[1]

pronounceable = set()
for line in (root / "data" / "CMUdict" / "cmudict-0.7b").read_text(encoding="latin-1").splitlines():
    if not line.startswith(";;;"):
        pronounceable.add(re.sub(r"\(\d+\)$", "", line.split("  ", 1)[0]).lower())


def words(piece: str) -> list[str]:
    """The piece's words, as CMUdict spells them."""
    piece = piece.replace("’", "'").replace("‘", "'")
    return [w.strip("'").lower() for w in re.findall(r"[A-Za-z][A-Za-z']*", piece)]


def tidy(piece: str) -> str:
    """The piece without its quotation marks (dialogue's, which split it
    oddly; the book writes ‘ only as one) or the punctuation around it."""
    piece = re.sub(r"[\"“”‘]", "", piece)
    return piece.strip(" ‘’'()[]—–-,;:.")


paragraphs = [" ".join(p.split()) for p in re.split(r"\n\s*\n", text)]
# A title's period doesn't end a sentence.
paragraphs = [re.sub(r"\b(Mr|Mrs|Dr|St|Mt)\. ", r"\1 ", p) for p in paragraphs]
pieces: list[str] = []
for paragraph in paragraphs:
    if re.fullmatch(r"[IVX]+", paragraph):  # a chapter heading
        continue
    for sentence in re.split(r"(?<=[.!?])[”’\")]*\s+", paragraph):
        candidates = [sentence]
        if len(words(sentence)) > MAX_WORDS:
            candidates = re.split(r"[,;:—–]\s*", sentence)
        for candidate in candidates:
            piece = tidy(candidate)
            w = words(piece)
            if MIN_WORDS <= len(w) <= MAX_WORDS and all(x in pronounceable for x in w):
                pieces.append(piece)

seen = set()
unique = [p for p in pieces if not (p in seen or seen.add(p))]
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text("".join(f"{p}\n" for p in unique), encoding="utf-8")
print(f"wrote {len(unique)} lines to {out}")
