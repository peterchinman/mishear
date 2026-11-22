# VarCon spelling variants

`varcon-to-american.tsv` maps British, Canadian, Australian and variant
spellings to the preferred American spelling of the same word, one
`variant<TAB>american` pair per line (`neighbour's	neighbor's`). mishear uses
it to treat *neighbour's* and *neighbor's* as the same word.

Derived from VarCon (`varcon/varcon.txt` in https://github.com/en-wl/wordlist,
part of SCOWL, http://wordlist.aspell.net/) on 2026-11-14 by
`scripts/varcon_map.py`. VarCon's copyright and permission
notices are in [LICENSE](LICENSE).
