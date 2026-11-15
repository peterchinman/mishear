"""Writes data/proverbs/lines.txt (at the repository root): the proverbial
phrases of Wikipedia's "List of proverbial phrases", one per line, for the
web page's "random line". A phrase is kept when it has 3 to 20 words, no
digits, and CMUdict lists every word, so a random line is always heard.

    curl -sfL -A mime-reader-data-script -o proverbs.wiki \\
      'https://en.wikipedia.org/w/index.php?title=List_of_proverbial_phrases&action=raw'
    python3 scripts/proverb_lines.py proverbs.wiki

The page's wikitext: each phrase is a bullet under a letter's heading. Links
become their text; citations, templates and markup go. A parenthesis that
notes a source or a date ("(Persian proverb)", "(Wilson Mizner (1876–1933))")
or gives another form ("(The fish rots from the head down)") goes; one
holding an optional part ("A friend in need (is a friend indeed)", "(A)
swarm in May") is kept, without its parentheses. Of "a/b" the first is kept.
An attribution after a dash or "attributed to", and a note after the phrase
("… fade away. From a Great War soldiers' song"), go.
"""

import pathlib
import re
import sys

MIN_WORDS, MAX_WORDS = 3, 20

source = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "proverbs.wiki")
root = pathlib.Path(__file__).resolve().parents[3]
out = root / "data" / "proverbs" / "lines.txt"

pronounceable = set()
for line in (root / "data" / "CMUdict" / "cmudict-0.7b").read_text(encoding="latin-1").splitlines():
    if not line.startswith(";;;"):
        pronounceable.add(re.sub(r"\(\d+\)$", "", line.split("  ", 1)[0]).lower())


def words(phrase: str) -> list[str]:
    phrase = phrase.replace("’", "'").replace("‘", "'")
    return [w.strip("'").lower() for w in re.findall(r"[A-Za-z][A-Za-z']*", phrase)]


def clean(item: str) -> str:
    item = re.sub(r"<ref[^>]*/>", "", item)
    item = re.sub(r"<ref[^>]*>.*?</ref>", "", item)
    item = re.sub(r"<[^>]+>", "", item)
    item = re.sub(r"\{\{\s*[nm]dash\s*\}\}", " – ", item)
    while re.search(r"\{\{[^{}]*\}\}", item):
        item = re.sub(r"\{\{[^{}]*\}\}", "", item)
    item = re.sub(r"\[\[[^\]|]*\|([^\]]*)\]\]", r"\1", item)  # [[target|text]]
    item = re.sub(r"\[\[([^\]]*)\]\]", r"\1", item)  # [[text]]
    item = item.replace("'''", "").replace("''", "")

    def parenthesis(m: re.Match) -> str:
        inside = m.group(1)
        # A source, a date or another form of the phrase: a note.
        note = (
            re.search(r"\d|proverb|saying|latin|from|meaning|attributed", inside, re.I)
            or (inside[:1].isupper() and len(inside.split()) >= 3)
        )
        return "" if note else inside

    while re.search(r"\([^()]*\)", item):
        item = re.sub(r"\(([^()]*)\)", parenthesis, item)
    item = re.sub(r"(\w+)(?:/\w+)+", r"\1", item)  # "none/one/some": the first
    item = re.split(r"\s+[–—]\s+|\s+(?:often |variously |also )?(?:attributed|ascribed)\b", item)[0]
    item = re.split(r"\.\s+(?=(?:From|Attributed|Originally|Usually|Often|Said|Quoted|Used|Popularized)\b)", item)[0]
    item = " ".join(item.split())
    return item.strip(" .,;:")


text = source.read_text(encoding="utf-8")
# The phrases sit under the letters' headings, before "See also".
body = re.split(r"^==\s*A\s*==\s*$", text, maxsplit=1, flags=re.M)[1]
body = re.split(r"^==\s*(See also|References|Notes|Further reading)\s*==", body, maxsplit=1, flags=re.M)[0]

phrases: list[str] = []
for line in body.splitlines():
    if not line.startswith("*"):
        continue
    phrase = clean(line.lstrip("*").strip())
    w = words(phrase)
    spelled = not re.search(r"\d", phrase)  # the page can't read "3"
    if spelled and MIN_WORDS <= len(w) <= MAX_WORDS and all(x in pronounceable for x in w):
        phrases.append(phrase)

seen = set()
unique = [p for p in phrases if not (p.lower() in seen or seen.add(p.lower()))]
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text("".join(f"{p}\n" for p in unique), encoding="utf-8")
print(f"wrote {len(unique)} phrases to {out}")
