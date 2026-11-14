//! The words a search may produce: CMUdict pronunciations of the most
//! frequent English words, in a trie, each with a language-model cost.

use std::collections::HashMap;
use std::path::Path;

use mime_reader::{InflectionRule, PronouncingDictionary, inflection_bases};

use crate::bigrams::{BigramTable, dequantize};
use crate::phone::Ph;
use std::sync::Arc;

/// A word id: an index into [`Lexicon::words`].
pub type WordId = u32;

#[derive(Default)]
struct Node {
    /// Sorted by phoneme.
    children: Vec<(Ph, u32)>,
    /// Words whose pronunciation ends here.
    words: Vec<WordId>,
}

/// A pronunciation trie over a frequency-ranked vocabulary.
pub struct Lexicon {
    words: Vec<String>,
    /// `−ln P(word)` under a unigram model.
    surprisal: Vec<f32>,
    nodes: Vec<Node>,
    index: HashMap<String, WordId>,
    max_depth: usize,
    bigrams: Option<Bigrams>,
    /// `sound[w]`: an id shared by every word whose first pronunciation is
    /// the same ("there", "their", "they're").
    sound: Vec<u32>,
    first: Vec<Vec<Ph>>,
    /// The words sharing each stem (see [`Self::same_stem`]).
    by_stem: HashMap<String, Vec<WordId>>,
    /// Each word's same-word class (see [`Self::same_word`]), and the
    /// classes by key.
    same: Vec<u32>,
    classes: Vec<Vec<WordId>>,
    class_by_key: HashMap<String, u32>,
    /// Each word's stem, keyed by its same-word key.
    stems: Vec<String>,
    variants: Arc<SpellingVariants>,
    /// The words with each sound (see [`Self::sound`]).
    by_sound: Vec<Vec<WordId>>,
}

/// A word's stem, by Snowball's English stemmer (Porter2): "fly", "flies"
/// and "flying" all give "fli". Irregular forms keep their own ("flew").
pub fn stem(word: &str) -> String {
    use rust_stemmers::{Algorithm, Stemmer};
    Stemmer::create(Algorithm::English)
        .stem(&spelling(word))
        .into_owned()
}

/// A word as the lexicon spells it: lowercase, with straight apostrophes
/// (prose editors type "neighbor’s").
pub fn spelling(word: &str) -> String {
    word.to_lowercase().replace(['’', '‘'], "'")
}

/// British, Canadian, Australian and variant spellings, each with the
/// preferred American spelling of the same word ("neighbour's" →
/// "neighbor's"), from VarCon: `data/VarCon/varcon-to-american.tsv`.
#[derive(Debug, Default, Clone)]
pub struct SpellingVariants {
    american: HashMap<String, String>,
}

impl SpellingVariants {
    /// Reads `variant<TAB>american` lines.
    pub fn read(path: &Path) -> Result<Self, String> {
        let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
        Self::parse(&text)
    }

    /// [`Self::read`] from the file's text.
    pub fn parse(text: &str) -> Result<Self, String> {
        let mut american = HashMap::new();
        for (n, line) in text.lines().enumerate() {
            if line.is_empty() {
                continue;
            }
            let (variant, preferred) = line.split_once('\t').ok_or_else(|| {
                format!("spelling variants, line {}: expected two columns", n + 1)
            })?;
            american.insert(spelling(variant), spelling(preferred));
        }
        Ok(Self { american })
    }

    /// The American spelling of `word` (lowercase, straight apostrophes),
    /// or `word` itself.
    pub fn american<'a>(&'a self, word: &'a str) -> &'a str {
        self.american.get(word).map_or(word, String::as_str)
    }

    pub fn len(&self) -> usize {
        self.american.len()
    }

    pub fn is_empty(&self) -> bool {
        self.american.is_empty()
    }
}

/// The layers a word may carry and still be the same word: possessives and
/// plurals ("music's", "neighbours'", "knives").
const SAME_WORD_RULES: [InflectionRule; 4] = [
    InflectionRule::ApostropheS,
    InflectionRule::SApostrophe,
    InflectionRule::S,
    InflectionRule::Ves,
];

/// Words whose 's is "is" or "has" ("it's", "let's"), not a possessive.
const CONTRACTING: [&str; 14] = [
    "he", "she", "it", "this", "that", "there", "here", "what", "who", "where", "when", "why",
    "how", "let",
];

/// Spelled and pronounced as a plural of the second word, but a word of
/// its own.
const NOT_PLURALS: [(&str, &str); 1] = [("news", "new")];

/// The word `word` is a form of, for telling hearings that give the line's
/// own words back: possessive and plural layers peeled off, the spelling
/// made American. "neighbours'", "neighbour's" and "neighbors" all give
/// "neighbor".
///
/// A layer is peeled only when the word sounds like its base with the
/// suffix added: "does" isn't "doe" + s. The 's of a contraction ("it's",
/// "let's") stays.
pub fn same_word_key<D: PronouncingDictionary + ?Sized>(
    dict: &D,
    variants: &SpellingVariants,
    word: &str,
) -> String {
    let mut word = spelling(word);
    // Each step makes the spelling American or peels a layer; a word
    // carries few of either.
    for _ in 0..6 {
        let american = variants.american(&word);
        if american != word {
            word = american.to_string();
            continue;
        }
        let Some(own) = dict.pronunciations_for(&word) else {
            break;
        };
        let base = inflection_bases(dict, &word).into_iter().find(|b| {
            SAME_WORD_RULES.contains(&b.rule)
                && !(b.rule == InflectionRule::ApostropheS
                    && CONTRACTING.contains(&b.base.as_str()))
                && !NOT_PLURALS.contains(&(word.as_str(), b.base.as_str()))
                && b.pronunciations
                    .iter()
                    .any(|p| own.pronunciations.contains(p))
        });
        match base {
            Some(b) => word = spelling(&b.base),
            None => break,
        }
    }
    word
}

/// The bigram model over this lexicon: a [`BigramTable`] seen through the
/// lexicon's words, smoothed toward the table's own word frequencies:
/// `P(w | v) = (count(v, w) + (μ + r(v))·Q(w)) / (count(v) + μ)`, so a pair
/// seen often is likely, a rarely seen left word says little, and the mass
/// of pairs left out of the table (`r(v)`: pruned, or with words outside
/// the lexicon) is spread by `Q(w)` rather than lost.
///
/// `Q(w) = count(w) / Σ count` over the lexicon's words in the table, where
/// `count(w)` is how often `w` is followed by any word: the table's own
/// unigram, so a word's misfit, `ln(Q(w) / P(w | v))`, measures only how it
/// goes with the word before. Measured against wordfreq's `P(w)` instead,
/// misfit also carried the gap between the two corpora: fiction's "stood"
/// was cheap after any word, and contractions, which the table splits
/// apart, cost 12 nats after any word. Words the table lacks fall back to
/// wordfreq's `P(w)`, so their misfit stays near zero.
struct Bigrams {
    table: Arc<BigramTable>,
    /// The smoothing strength `μ`: how many words of evidence the unigram
    /// prior is worth.
    prior: f32,
    /// Each lexicon word's index in the table (`u32::MAX`: not there).
    in_table: Vec<u32>,
    /// `count(v)`: how often `v` is followed by any word.
    totals: Vec<f32>,
    /// `μ + r(v)`: the prior's weight after `v`.
    backoff: Vec<f32>,
    /// `−ln Q(w)`.
    base: Vec<f32>,
    /// The least misfit over every context, the start (0) included.
    best_misfit: Vec<f32>,
}

/// The default smoothing strength `μ`, chosen for the Google Books counts:
/// with their billions of words, pairs need a strong prior to say little.
pub const BIGRAM_PRIOR: f32 = 100_000.0;

/// A word with its Zipf frequency (log10 occurrences per billion words).
pub struct Frequency {
    pub word: String,
    pub zipf: f32,
}

/// Reads `word<TAB>zipf` lines, most frequent first.
pub fn read_frequencies(path: &Path) -> Result<Vec<Frequency>, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    parse_frequencies(&text).map_err(|e| format!("{}: {e}", path.display()))
}

/// Parses `word<TAB>zipf` lines, most frequent first.
pub fn parse_frequencies(text: &str) -> Result<Vec<Frequency>, String> {
    text.lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            let (word, zipf) = line
                .split_once('\t')
                .ok_or_else(|| format!("malformed line {line:?}"))?;
            let zipf = zipf.trim().parse().map_err(|e| format!("{line:?}: {e}"))?;
            Ok(Frequency {
                word: word.to_string(),
                zipf,
            })
        })
        .collect()
}

/// Real words: those a word list such as ENABLE has (it lists every
/// inflected form, and no names, brands or abbreviations), and contractions
/// and possessives of them: "it's", "don't", "people's", but not "america's"
/// or "o'brien".
pub struct CommonWords {
    words: std::collections::HashSet<String>,
}

/// What follows the apostrophe of a contraction or possessive: "it's",
/// "you're", "i've", "we'll", "she'd", "i'm", "don't".
const CLITICS: [&str; 7] = ["s", "re", "ve", "ll", "d", "m", "t"];

/// Negations whose base isn't a word: "can't", "won't", "shan't", "ain't".
const NEGATED: [&str; 4] = ["ca", "wo", "sha", "ai"];

/// Contractions with parts that aren't words.
const CONTRACTIONS: [&str; 4] = ["o'clock", "c'mon", "y'know", "y'all"];

impl CommonWords {
    /// Reads a word list, one word per line; capitalized entries (proper
    /// nouns, in lists that have them) are ignored.
    pub fn read(path: &Path) -> Result<Self, String> {
        let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
        Ok(Self::parse(&text))
    }

    /// [`Self::read`] from the list's text.
    pub fn parse(text: &str) -> Self {
        Self {
            words: text
                .lines()
                .map(str::trim)
                .filter(|w| w.chars().next().is_some_and(|c| c.is_ascii_lowercase()))
                .map(str::to_string)
                .collect(),
        }
    }

    pub fn contains(&self, word: &str) -> bool {
        if word.chars().count() == 1 {
            return matches!(word, "a" | "i" | "o");
        }
        if !word.contains('\'') {
            return self.words.contains(word);
        }
        if CONTRACTIONS.contains(&word) {
            return true;
        }
        if let Some(base) = word.strip_suffix("n't") {
            return self.words.contains(base) || NEGATED.contains(&base);
        }
        // "it's", "people's", "i'm", "'em": a word, then clitics.
        word.split('\'').enumerate().all(|(k, part)| {
            part.is_empty()
                || part == "i"
                || self.words.contains(part)
                || (k > 0 && CLITICS.contains(&part))
        })
    }
}

impl Bigrams {
    /// `−ln P(w | v)`.
    fn surprisal_after(&self, v: WordId, w: WordId) -> f32 {
        let (tv, tw) = (self.in_table[v as usize], self.in_table[w as usize]);
        let count = if tv == u32::MAX || tw == u32::MAX {
            0.0
        } else {
            self.table.count(tv, tw).unwrap_or(0.0)
        };
        let p = (count + self.backoff[v as usize] * (-self.base[w as usize]).exp())
            / (self.totals[v as usize] + self.prior);
        -p.ln()
    }
}

impl Lexicon {
    /// The `max_words` most frequent words that CMUdict can pronounce, that
    /// are spelled with letters and apostrophes only, and that `keep`
    /// accepts — with every CMUdict pronunciation, or only the first.
    pub fn build<D: PronouncingDictionary>(
        dict: &D,
        frequencies: &[Frequency],
        max_words: usize,
        all_pronunciations: bool,
        keep: impl Fn(&str) -> bool,
    ) -> Self {
        let mut lexicon = Self {
            words: Vec::new(),
            surprisal: Vec::new(),
            nodes: vec![Node::default()],
            index: HashMap::new(),
            max_depth: 0,
            bigrams: None,
            sound: Vec::new(),
            first: Vec::new(),
            by_stem: HashMap::new(),
            by_sound: Vec::new(),
            same: Vec::new(),
            classes: Vec::new(),
            class_by_key: HashMap::new(),
            stems: Vec::new(),
            variants: Arc::default(),
        };
        let mut sounds: HashMap<Vec<Ph>, u32> = HashMap::new();
        for frequency in frequencies {
            if lexicon.words.len() >= max_words {
                break;
            }
            let word = frequency.word.as_str();
            let spelled_plainly = word.chars().all(|c| c.is_ascii_alphabetic() || c == '\'')
                && word.chars().any(|c| c.is_ascii_alphabetic());
            if !spelled_plainly || lexicon.index.contains_key(word) || !keep(word) {
                continue;
            }
            let Some(pronunciations) = dict.lookup(word) else {
                continue;
            };
            let id = lexicon.words.len() as WordId;
            lexicon.words.push(word.to_string());
            // P = 10^(zipf − 9) occurrences per word of text.
            lexicon
                .surprisal
                .push((9.0 - frequency.zipf) * std::f32::consts::LN_10);
            lexicon.index.insert(word.to_string(), id);
            let first: Vec<Ph> = pronunciations[0].iter().map(Ph::from_phoneme).collect();
            let next = sounds.len() as u32;
            lexicon
                .sound
                .push(*sounds.entry(first.clone()).or_insert(next));
            let sound = lexicon.sound[id as usize] as usize;
            if sound == lexicon.by_sound.len() {
                lexicon.by_sound.push(Vec::new());
            }
            lexicon.by_sound[sound].push(id);
            lexicon.first.push(first);
            let mut seen: Vec<Vec<Ph>> = Vec::new();
            let count = if all_pronunciations {
                pronunciations.len()
            } else {
                1
            };
            for pronunciation in &pronunciations[..count] {
                let phonemes: Vec<Ph> = pronunciation.iter().map(Ph::from_phoneme).collect();
                if !seen.contains(&phonemes) {
                    lexicon.insert(&phonemes, id);
                    seen.push(phonemes);
                }
            }
        }
        lexicon.group_forms(dict);
        lexicon
    }

    /// Spells words the American way when telling whether they are the
    /// same word or share a stem: "neighbour's" is then "neighbor".
    pub fn set_spelling_variants<D: PronouncingDictionary + ?Sized>(
        &mut self,
        dict: &D,
        variants: Arc<SpellingVariants>,
    ) {
        self.variants = variants;
        self.group_forms(dict);
    }

    pub fn spelling_variants(&self) -> Arc<SpellingVariants> {
        self.variants.clone()
    }

    /// Fills the same-word classes and the stems from each word's
    /// [`same_word_key`].
    fn group_forms<D: PronouncingDictionary + ?Sized>(&mut self, dict: &D) {
        self.same.clear();
        self.classes.clear();
        self.class_by_key.clear();
        self.stems.clear();
        self.by_stem.clear();
        for id in 0..self.words.len() {
            let key = self.key(dict, &self.words[id]);
            let next = self.classes.len() as u32;
            let class = *self.class_by_key.entry(key.clone()).or_insert(next);
            if class == next {
                self.classes.push(Vec::new());
            }
            self.classes[class as usize].push(id as WordId);
            self.same.push(class);
            let root = stem(&key);
            self.by_stem
                .entry(root.clone())
                .or_default()
                .push(id as WordId);
            self.stems.push(root);
        }
    }

    fn key<D: PronouncingDictionary + ?Sized>(&self, dict: &D, word: &str) -> String {
        same_word_key(dict, &self.variants, word)
    }

    fn insert(&mut self, phonemes: &[Ph], word: WordId) {
        let mut node = 0usize;
        for &p in phonemes {
            let children = &self.nodes[node].children;
            node = match children.binary_search_by_key(&p, |&(q, _)| q) {
                Ok(k) => children[k].1 as usize,
                Err(k) => {
                    let child = self.nodes.len();
                    self.nodes.push(Node::default());
                    self.nodes[node].children.insert(k, (p, child as u32));
                    child
                }
            };
        }
        self.nodes[node].words.push(word);
        self.max_depth = self.max_depth.max(phonemes.len());
    }

    pub fn len(&self) -> usize {
        self.words.len()
    }

    pub fn is_empty(&self) -> bool {
        self.words.is_empty()
    }

    /// The word's sound class: equal for homophones (by first
    /// pronunciation).
    pub fn sound(&self, id: WordId) -> u32 {
        self.sound[id as usize]
    }

    /// The word's first pronunciation.
    pub fn first_pronunciation(&self, id: WordId) -> &[Ph] {
        &self.first[id as usize]
    }

    pub fn word(&self, id: WordId) -> &str {
        &self.words[id as usize]
    }

    pub fn id(&self, word: &str) -> Option<WordId> {
        self.index.get(&spelling(word)).copied()
    }

    /// Every word that sounds like `id` (by first pronunciation), `id`
    /// itself included: "there", "their", "they're".
    pub fn homophones(&self, id: WordId) -> &[WordId] {
        &self.by_sound[self.sound(id) as usize]
    }

    /// Every form of `word` in the lexicon, `word` itself included: its
    /// possessives and plurals, in any spelling ("neighbor", "neighbour's",
    /// "neighbors'"). See [`same_word_key`]. `dict` pronounces `word`,
    /// which needn't be in the lexicon.
    pub fn same_word<D: PronouncingDictionary + ?Sized>(&self, dict: &D, word: &str) -> &[WordId] {
        self.class_by_key
            .get(&self.key(dict, word))
            .map_or(&[], |&c| &self.classes[c as usize])
    }

    /// [`Self::same_word`] for a lexicon word.
    pub fn same_word_of(&self, id: WordId) -> &[WordId] {
        &self.classes[self.same[id as usize] as usize]
    }

    /// Every word sharing `word`'s stem, `word` itself included: the
    /// [`stem`] of its [`same_word_key`], so "neighbourly" shares
    /// "neighbor"'s.
    pub fn same_stem<D: PronouncingDictionary + ?Sized>(&self, dict: &D, word: &str) -> &[WordId] {
        self.by_stem
            .get(&stem(&self.key(dict, word)))
            .map_or(&[], Vec::as_slice)
    }

    /// [`Self::same_stem`] for a lexicon word.
    pub fn same_stem_of(&self, id: WordId) -> &[WordId] {
        self.by_stem
            .get(&self.stems[id as usize])
            .map_or(&[], Vec::as_slice)
    }

    /// `−ln P(word)`: about 3 for "the", 8 for "nice", 15 for "aardvark".
    pub fn surprisal(&self, id: WordId) -> f32 {
        self.surprisal[id as usize]
    }

    /// Reads word-pair counts (a [`BigramTable`] file, text or packed) for
    /// [`Self::surprisal_after`], smoothed with strength `prior` (μ; see
    /// [`BIGRAM_PRIOR`]).
    pub fn load_bigrams(&mut self, path: &Path, prior: f32) -> Result<(), String> {
        self.attach_bigrams(Arc::new(BigramTable::read(path)?), prior);
        Ok(())
    }

    /// [`Self::load_bigrams`] from the text format.
    pub fn parse_bigrams(&mut self, text: &str, prior: f32) -> Result<(), String> {
        self.attach_bigrams(Arc::new(BigramTable::parse_text(text)?), prior);
        Ok(())
    }

    /// Scores words by the previous word too, with `table`'s counts
    /// smoothed with strength `prior`.
    pub fn attach_bigrams(&mut self, table: Arc<BigramTable>, prior: f32) {
        let n = self.len();
        let in_table: Vec<u32> = self
            .words
            .iter()
            .map(|w| table.id(w).unwrap_or(u32::MAX))
            .collect();
        let mut in_lexicon = vec![u32::MAX; table.words().len()];
        for (v, &t) in in_table.iter().enumerate() {
            if t != u32::MAX {
                in_lexicon[t as usize] = v as u32;
            }
        }
        let totals: Vec<f32> = in_table
            .iter()
            .map(|&t| {
                if t == u32::MAX {
                    0.0
                } else {
                    table.total(t) as f32
                }
            })
            .collect();
        let mut backoff = vec![prior; n];
        for (v, &t) in in_table.iter().enumerate() {
            if t == u32::MAX {
                continue;
            }
            let (rights, counts) = table.row(t);
            let listed: f64 = rights
                .iter()
                .zip(counts)
                .filter(|&(&w, _)| in_lexicon[w as usize] != u32::MAX)
                .map(|(_, &q)| f64::from(dequantize(q)))
                .sum();
            backoff[v] = prior + (f64::from(totals[v]) - listed).max(0.0) as f32;
        }
        let total: f64 = totals.iter().map(|&t| f64::from(t)).sum();
        let base: Vec<f32> = totals
            .iter()
            .zip(&self.surprisal)
            .map(|(&count, &surprisal)| {
                if count > 0.0 {
                    -(f64::from(count) / total).ln() as f32
                } else {
                    surprisal
                }
            })
            .collect();
        // Unseen pairs get at most `Q(w)`, since `r(v) ≤ count(v)`, so a
        // misfit of at least 0: the least is at the start or a listed pair.
        let mut best_misfit = vec![0.0f32; n];
        for (v, &t) in in_table.iter().enumerate() {
            if t == u32::MAX {
                continue;
            }
            let (rights, counts) = table.row(t);
            for (&w, &q) in rights.iter().zip(counts) {
                let w = in_lexicon[w as usize];
                if w == u32::MAX {
                    continue;
                }
                let p =
                    (dequantize(q) + backoff[v] * (-base[w as usize]).exp()) / (totals[v] + prior);
                let misfit = -p.ln() - base[w as usize];
                best_misfit[w as usize] = best_misfit[w as usize].min(misfit);
            }
        }
        self.bigrams = Some(Bigrams {
            table,
            prior,
            in_table,
            totals,
            backoff,
            base,
            best_misfit,
        });
    }

    /// The word-pair counts in use, and their smoothing strength.
    pub fn bigram_table(&self) -> Option<(Arc<BigramTable>, f32)> {
        self.bigrams.as_ref().map(|b| (b.table.clone(), b.prior))
    }

    pub fn has_bigrams(&self) -> bool {
        self.bigrams.is_some()
    }

    /// `−ln P(word | previous)`: the bigram model when loaded (and there is
    /// a previous word), else [`Self::surprisal`].
    pub fn surprisal_after(&self, previous: Option<WordId>, word: WordId) -> f32 {
        match (&self.bigrams, previous) {
            (Some(b), Some(v)) => b.surprisal_after(v, word),
            _ => self.surprisal[word as usize],
        }
    }

    /// How much less likely `word` is after `previous` than the word-pair
    /// counts make it on its own, in nats: `ln(Q(word) / P(word |
    /// previous))`, with `Q` the counts' own word frequencies (not
    /// wordfreq's), negative when it goes with the one before. 0 at the
    /// line's start, or without bigrams.
    pub fn misfit(&self, previous: Option<WordId>, word: WordId) -> f32 {
        match (&self.bigrams, previous) {
            (Some(b), Some(v)) => b.surprisal_after(v, word) - b.base[word as usize],
            _ => 0.0,
        }
    }

    /// The least [`Self::misfit`] over every context (at most 0, the
    /// line's start): a lower bound the search prunes with.
    pub fn best_misfit(&self, word: WordId) -> f32 {
        self.bigrams
            .as_ref()
            .map_or(0.0, |b| b.best_misfit[word as usize])
    }

    pub fn node_count(&self) -> usize {
        self.nodes.len()
    }

    pub fn max_depth(&self) -> usize {
        self.max_depth
    }

    pub(crate) fn children(&self, node: usize) -> &[(Ph, u32)] {
        &self.nodes[node].children
    }

    pub(crate) fn words_at(&self, node: usize) -> &[WordId] {
        &self.nodes[node].words
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mime_reader::{CmuDictionary, ConfiguredDictionary, PronunciationMode};
    use std::sync::OnceLock;

    fn repo(relative: &str) -> std::path::PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../..")
            .join(relative)
    }

    fn cmudict() -> &'static ConfiguredDictionary<CmuDictionary> {
        static DICT: OnceLock<ConfiguredDictionary<CmuDictionary>> = OnceLock::new();
        DICT.get_or_init(|| {
            CmuDictionary::load(repo("data/CMUdict/cmudict-0.7b"))
                .unwrap()
                .with_pronunciation_mode(PronunciationMode::AllowDerived)
        })
    }

    fn varcon() -> Arc<SpellingVariants> {
        static VARIANTS: OnceLock<Arc<SpellingVariants>> = OnceLock::new();
        VARIANTS
            .get_or_init(|| {
                Arc::new(
                    SpellingVariants::read(&repo("data/VarCon/varcon-to-american.tsv")).unwrap(),
                )
            })
            .clone()
    }

    fn key(word: &str) -> String {
        same_word_key(cmudict(), &varcon(), word)
    }

    #[test]
    fn possessives_plurals_and_spellings_share_a_key() {
        for word in ["music", "music's", "musics"] {
            assert_eq!(key(word), "music", "{word}");
        }
        for word in [
            "neighbour",
            "neighbour's",
            "neighbours",
            "neighbours'",
            "neighbor",
            "neighbor's",
            "neighbors",
            "neighbors'",
            "neighbour’s",
            "Neighbour's",
        ] {
            assert_eq!(key(word), "neighbor", "{word}");
        }
        for word in ["colour", "colours", "color"] {
            assert_eq!(key(word), "color", "{word}");
        }
        assert_eq!(key("grey"), key("gray"));
        assert_eq!(key("people's"), "people");
        assert_eq!(key("knives"), "knife");
    }

    #[test]
    fn lookalikes_and_contractions_keep_their_own_key() {
        // Other words of the same stem stay apart.
        assert_eq!(key("musical"), "musical");
        // Spelled like a plural, but pronounced otherwise.
        assert_eq!(key("does"), "does");
        // Contractions, not possessives.
        assert_eq!(key("it's"), "it's");
        assert_eq!(key("let's"), "let's");
        assert_eq!(key("news"), "news");
        // Homophones are different words.
        assert_ne!(key("their"), key("there"));
    }

    #[test]
    fn spelling_variants_map_to_american_spellings_in_one_step() {
        let variants = varcon();
        for (variant, american) in [
            ("colour", "color"),
            ("neighbour", "neighbor"),
            ("neighbour's", "neighbor's"),
            ("theatre", "theater"),
            ("grey", "gray"),
        ] {
            assert_eq!(variants.american(variant), american);
        }
        for (variant, american) in &variants.american {
            assert_ne!(variant, american);
            // A target is never itself mapped, so one lookup suffices.
            assert_eq!(variants.american(american), american.as_str(), "{variant}");
        }
        assert!(SpellingVariants::parse("colour color\n").is_err());
    }

    /// A lexicon of `words` under the real CMUdict, most frequent first.
    fn lexicon_of(words: &[&str]) -> Lexicon {
        let frequencies: Vec<Frequency> = words
            .iter()
            .enumerate()
            .map(|(k, word)| Frequency {
                word: word.to_string(),
                zipf: 7.0 - k as f32 * 0.01,
            })
            .collect();
        let mut lexicon = Lexicon::build(cmudict(), &frequencies, usize::MAX, false, |_| true);
        lexicon.set_spelling_variants(cmudict(), varcon());
        lexicon
    }

    #[test]
    fn the_lexicon_groups_each_word_with_its_forms() {
        let lexicon = lexicon_of(&[
            "music",
            "music's",
            "musical",
            "neighbor",
            "neighbors",
            "neighbor's",
            "their",
            "there",
        ]);
        let id = |w: &str| lexicon.id(w).unwrap();
        let mut forms = lexicon.same_word_of(id("music's")).to_vec();
        forms.sort();
        assert_eq!(forms, [id("music"), id("music's")]);
        // Words outside the lexicon find their forms in it.
        let mut forms = lexicon.same_word(cmudict(), "Neighbour’s").to_vec();
        forms.sort();
        assert_eq!(forms, [id("neighbor"), id("neighbors"), id("neighbor's")]);
        assert_eq!(lexicon.same_word_of(id("their")), [id("their")]);
        // Stems are taken from the same-word key.
        assert!(lexicon.same_stem_of(id("musical")).contains(&id("music")));
        assert!(
            lexicon
                .same_stem(cmudict(), "neighbourly")
                .contains(&id("neighbor"))
        );
        assert_eq!(lexicon.id("neighbor’s"), lexicon.id("neighbor's"));
    }

    #[test]
    fn common_words_keep_listed_words_and_their_contractions() {
        let common = CommonWords::parse(
            "boy\nboys\nrunning\nlove\ncities\nit\ndo\nis\npeople\nem\ncause\nma\nam\nTexas\n",
        );
        for word in [
            "boy", "boys", "running", "cities", "a", "i", "o", "boy's", "people's", "it's", "i'm",
            "don't", "isn't", "can't", "won't", "'em", "'cause", "ma'am", "o'clock",
        ] {
            assert!(common.contains(word), "{word}");
        }
        // Listed forms only (no guessing at "loved"), and no names.
        for word in [
            "loved",
            "boyd",
            "b",
            "texas",
            "james's",
            "o'brien",
            "america's",
            "doesn't",
        ] {
            assert!(!common.contains(word), "{word}");
        }
    }
}
