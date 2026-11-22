"""Writes data/gatsby/lines.txt (at the repository root): sentences of F.
Scott Fitzgerald's The Great Gatsby (1925; public domain) for the web
page's "random line". A sentence is kept when it is
- not too long: 5 to 14 words;
- readable: every word pronounced by CMUdict or derived from it by
  mime-reader's rules ("Gatsby's", "pointlessly"), as the page reads a
  line, so a random line is always heard (examples/readable_lines.rs);
- narration, not dialogue: it has no quotation mark and doesn't start
  inside a quotation (tracked across a paragraph's sentences).

    curl -sfLO https://www.gutenberg.org/cache/epub/64317/pg64317.txt
    python3 scripts/gatsby_lines.py pg64317.txt

(When gutenberg.org is down, its mirror has the same ebook:
https://gutenberg.pglaf.org/6/4/3/1/64317/64317-0.txt.)

The text is Project Gutenberg's ebook #64317, its header, license and
contents left out.
"""

import pathlib
import re
import subprocess
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

def words(piece: str) -> list[str]:
    """The piece's words, to count them."""
    piece = piece.replace("’", "'").replace("‘", "'")
    return [w.strip("'").lower() for w in re.findall(r"[A-Za-z][A-Za-z']*", piece)]


def tidy(sentence: str) -> str:
    """The sentence without its final period, a list's leading "*" (Gatsby's
    boyhood schedule) or the space around it."""
    return sentence.strip().lstrip("* ").rstrip(".").strip()


paragraphs = [" ".join(p.split()) for p in re.split(r"\n\s*\n", text)]
# A title's period doesn't end a sentence.
paragraphs = [re.sub(r"\b(Mr|Mrs|Dr|St|Mt)\. ", r"\1 ", p) for p in paragraphs]
pieces: list[str] = []
for paragraph in paragraphs:
    if re.fullmatch(r"[IVX]+", paragraph):  # a chapter heading
        continue
    quoted = False  # inside a quotation where this sentence starts
    for sentence in re.split(r"(?<=[.!?])(?<![A-Z]\.)\s+(?=[^a-z])", paragraph):
        dialogue = quoted or any(mark in sentence for mark in "“”\"‘")
        # Where the quotation stands after this sentence: open quotes past
        # its last close.
        last_open, last_close = sentence.rfind("“"), sentence.rfind("”")
        if last_open > last_close:
            quoted = True
        elif last_close > last_open:
            quoted = False
        if dialogue:
            continue
        piece = tidy(sentence)
        if MIN_WORDS <= len(words(piece)) <= MAX_WORDS:
            pieces.append(piece)

seen = set()
unique = [p for p in pieces if not (p in seen or seen.add(p))]
# Keep the sentences mishear can read, in the book's order.
readable = set(
    subprocess.run(
        ["cargo", "run", "-q", "--release", "-p", "mishear", "--example", "readable_lines"],
        input="".join(f"{p}\n" for p in unique),
        capture_output=True,
        text=True,
        check=True,
        cwd=root,
    ).stdout.splitlines()
)
unique = [p for p in unique if p in readable]
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text("".join(f"{p}\n" for p in unique), encoding="utf-8")
print(f"wrote {len(unique)} lines to {out}")
