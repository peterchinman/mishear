import './style.css';
import type {
  CostDto,
  DefaultsDto,
  DeformationDto,
  LexiconInfoDto,
  LexiconOptions,
  Mode,
  RequestDto,
  ResultDto,
  SearchDto,
} from 'mishear';
import { LINES } from './lines';
import { sameLexicon as same, type FromWorker, type ToWorker } from './protocol';

// ---------------------------------------------------------------- knobs ----

interface NumberKnob {
  type: 'number';
  key: string;
  label: string;
  hint: string;
  /** The technical description, behind the knob's ⓘ button. */
  info: string;
  min: number;
  max: number;
  step: number;
  /** Optional knobs (`null` in Rust) get an on/off box; this is the value they turn on at. */
  onValue?: number;
  /** Rebuilds the lexicon: apply on release, not while dragging. */
  heavy?: boolean;
}
interface BoolKnob {
  type: 'bool';
  key: string;
  label: string;
  hint: string;
  /** The technical description, behind the knob's ⓘ button. */
  info: string;
  heavy?: boolean;
}
type Knob = NumberKnob | BoolKnob;
type Group = 'search' | 'cost' | 'lexicon';

const SEARCH_KNOBS: Knob[] = [
  { type: 'number', key: 'results', label: 'results', hint: 'How many hearings to show.', info: 'The exact top N hearings by total cost.', min: 1, max: 50, step: 1 },
  {
    type: 'number',
    key: 'familiar',
    label: 'familiar words',
    hint: 'Vocabulary size: this many of the most common words pay no rarity cost.',
    info: 'The listener’s vocabulary: the lexicon’s most frequent words up to this many pay no rarity cost, and a rarer word pays for how much rarer it is than the last of them. “Rarity cost” sets how steep that edge is. Off: every word pays for all its rarity, “the” included, so rarity cost also favors hearings of fewer words.',
    min: 500,
    max: 50000,
    step: 500,
    onValue: 14000,
  },
  {
    type: 'number',
    key: 'commonness',
    label: 'rarity cost',
    hint: 'How strongly common words are preferred over rare ones.',
    info: 'Cost per nat of a word’s rarity, −ln P(word), beyond the familiar words’ (all of it when “familiar words” is off): how much common words are preferred, or how steep the edge of the vocabulary is. A word twice as rare as the last familiar one pays 0.7 × this; ten times as rare, 2.3 ×. 0: a rare word costs no more than “the”. With “familiar words” off and this high, hearings collapse into single long words (“recommendations”).',
    min: 0,
    max: 0.5,
    step: 0.005,
  },
  {
    type: 'number',
    key: 'fit',
    label: 'sense',
    hint: 'How much each word must make sense after the one before.',
    info: 'Cost per nat of how much less likely a word is after the one before than on its own (a saving when they go together), both measured in Google Books fiction’s word pairs: how much the hearing’s neighbouring words must make sense. 0: words alone (exact, faster, no 29 MB download). Around 0.05 it shapes hearings (“case this guy”); a word’s cost per word + rarity cost + sense never goes below zero.',
    min: 0,
    max: 0.5,
    step: 0.005,
  },
  { type: 'number', key: 'word_penalty', label: 'cost per word', hint: 'Higher prefers fewer, longer words.', info: 'Added to every heard word’s cost, so it trades many short words against fewer long ones. A word’s cost per word + rarity cost + sense never goes below zero.', min: 0, max: 2, step: 0.01 },
  {
    type: 'number',
    key: 'shortlist',
    label: 'bigram shortlist',
    hint: 'Pair-search width: wider is more exact and slower.',
    info: 'With sense above 0: words kept per input span before the previous word is known. The search is exact only up to it.',
    min: 5,
    max: 200,
    step: 1,
  },
  {
    type: 'number',
    key: 'beam',
    label: 'bigram beam',
    hint: 'Partial hearings the pair search keeps: wider is more exact, slower.',
    info: 'With sense above 0: partial hearings kept per position. Wider is closer to exact and slower. At a small sense weight, narrow costs nothing; at 0.1, 50 makes a few hearings slightly worse than 400.',
    min: 10,
    max: 400,
    step: 10,
  },
  {
    type: 'bool',
    key: 'distinct_sounds',
    label: 'merge same-sound hearings',
    hint: 'Merge hearings that sound the same (“there” / “their”).',
    info: 'Treat hearings with the same sounds, spelled differently, as one, keeping the cheapest spelling. Off: list every spelling.',
  },
  {
    type: 'number',
    key: 'novelty',
    label: 'novelty',
    hint: 'Penalty for hearing the line’s own words back, in any form.',
    info: 'Extra cost per heard word that the line already contains, in any form: possessives, plurals and other spellings (“music’s” for “music”, “neighbors” for “neighbour’s”). 0 lets the line hear itself back.',
    min: 0,
    max: 5,
    step: 0.05,
  },
  {
    type: 'number',
    key: 'variety',
    label: 'variety of list',
    hint: 'Penalty for reusing words from the hearings above, so the list varies.',
    info: 'Extra cost per word an earlier hearing in the list used, in any form (“arrive” after “arrives”), or a homophone of one (“cents” after “sense”), as novelty does for the line’s own words. Each hearing is then the best one given those above it, so the list varies. 0: the plain top N, which often differ by a word. With bigrams on, it slows the search several-fold.',
    min: 0,
    max: 5,
    step: 0.05,
  },
  {
    type: 'number',
    key: 'root',
    label: 'same-root penalty',
    hint: 'Penalty for words sharing a root with the line’s (“flying” for “fly”).',
    info: 'Extra cost per heard word sharing a stem with a word of the line: “flying” for “fly in”, “flies” for “fly” (Snowball English stemmer, on American spellings). The same word counts too, on top of novelty. Irregular forms (“flew”) aren’t caught.',
    min: 0,
    max: 5,
    step: 0.05,
  },
  {
    type: 'number',
    key: 'function_share',
    label: 'function-word share',
    hint: 'How much of those penalties small words like “the” pay.',
    info: 'The share of the novelty and same-root costs charged when the line’s word is a function word (the 150 most frequent).',
    min: 0,
    max: 1,
    step: 0.05,
  },
  {
    type: 'number',
    key: 'crossing',
    label: 'cross word boundaries',
    hint: 'Reward for cutting across the line’s word breaks (“this guy” for “the sky”).',
    info: 'Reward per word boundary of the line that a hearing cuts across (“this guy” for “the sky” cuts the|sky). Charged instead as a cost on each boundary a hearing keeps: that ranks hearings the same way and keeps the search exact, so the costs shown include it.',
    min: 0,
    max: 3,
    step: 0.05,
  },
  { type: 'number', key: 'max_bound', label: 'max bound', hint: 'How far the search keeps looking before settling for fewer results.', info: 'The top-N search raises its cost bound in rounds until N hearings fit under it; this caps the bound. Lower is faster on lines with few good hearings, and may return fewer.', min: 2, max: 60, step: 0.5 },
];

const COST_KNOBS: Knob[] = [
  { type: 'number', key: 'vowel_substitution', label: 'vowel substitution', hint: 'Cost of hearing one vowel as another.', info: 'Cost of hearing one vowel as the farthest-apart other on the vowel chart; nearer vowels cost proportionally less.', min: 0, max: 3, step: 0.05 },
  { type: 'number', key: 'consonant_substitution', label: 'consonant substitution', hint: 'Cost of hearing one consonant as another.', info: 'Cost of hearing one consonant as the most different other, by place, manner, voicing and sibilance; closer consonants cost proportionally less.', min: 0, max: 3, step: 0.05 },
  { type: 'number', key: 'stressed_vowel_indel', label: 'stressed vowel add/drop', hint: 'Cost of adding or dropping a stressed syllable.', info: 'Hearing a stressed vowel (a syllable) that isn’t there, or missing one.', min: 0, max: 3, step: 0.05 },
  { type: 'number', key: 'unstressed_vowel_indel', label: 'unstressed vowel add/drop', hint: 'Cost of adding or dropping an unstressed syllable.', info: 'Hearing an unstressed vowel (mostly a schwa) that isn’t there, or missing one.', min: 0, max: 3, step: 0.05 },
  { type: 'number', key: 'consonant_indel', label: 'consonant add/drop', hint: 'Cost of adding or dropping a consonant.', info: 'Hearing a consonant that isn’t there, or missing one.', min: 0, max: 3, step: 0.05 },
  {
    type: 'number',
    key: 'stress_mismatch',
    label: 'rhythm (stress mismatch)',
    hint: 'How closely hearings must keep the line’s rhythm.',
    info: 'Extra for hearing a stressed vowel as an unstressed one or the reverse: how closely a hearing must keep the line’s rhythm.',
    min: 0,
    max: 2,
    step: 0.05,
  },
  {
    type: 'number',
    key: 'swap',
    label: 'adjacent swap',
    hint: 'Allow swapped neighbouring consonants (“ask” ↔ “aks”) at this cost.',
    info: 'Hearing two adjacent consonants swapped (“ask” ↔ “aks”) as one edit at this cost. Off: no swaps.',
    min: 0,
    max: 2,
    step: 0.05,
    onValue: 0.5,
  },
];

const LEXICON_KNOBS: Knob[] = [
  { type: 'number', key: 'vocabulary', label: 'vocabulary', hint: 'How many of the most common words hearings can use.', info: 'The most frequent words kept from the word-frequency list. Every frequent word is in, names and brands included, but single letters other than “a” and “I”; two-letter words but English ones (“to”, “us”); abbreviations (said as letters, “TV”; spelled without a vowel, “Sr”; read as the longer word, “etc”); and hand-made lists of foreign words (“le”, “un”), fragments (“ve”, “ing”), clipped words (“gov”, “app”), short names (“jo”) and interjections (“um”, “hmm”, “ooh”). Changing it rebuilds the lexicon.', min: 1000, max: 100000, step: 1000, heavy: true },
  { type: 'bool', key: 'all_pronunciations', label: 'every pronunciation', hint: 'Use every dictionary pronunciation of a word, not just the first.', info: 'Match each word under every CMUdict pronunciation (“either” as EE-ther and EYE-ther), or only its first. Changing it rebuilds the lexicon.', heavy: true },
  {
    type: 'number',
    key: 'bigram_prior',
    label: 'bigram smoothing μ',
    hint: 'How far rarely seen word pairs fall back on single-word frequencies.',
    info: 'Dirichlet smoothing: how far a rarely seen word pair falls back on the single-word frequency. The Google Books counts run to billions, so this is large; scores on held-out text barely change between 10,000 and 1,000,000.',
    min: 1000,
    max: 1000000,
    step: 1000,
    heavy: true,
  },
];

// ---------------------------------------------------------------- state ----

interface State {
  /** The saved format: 3 and up save settings as changes from the defaults;
   * 4 has commonness and fit. */
  v?: number;
  mode: Mode;
  text: string;
  phonemes: string;
  search: SearchDto;
  cost: CostDto;
  lexicon: LexiconOptions;
  autoRun: boolean;
  sweepKnob: string;
  sweepValues: string;
  /** The profile last applied or saved, if any (see "profiles"). */
  profile?: string;
}

// Only settings changed from their defaults are saved, so a change of default
// reaches everyone who hadn't touched that setting.
const STORAGE_KEY = 'mishear-web-state-v3';
const OLD_STORAGE_KEY = 'mishear-web-state-v2';
const FIRST_LINE = 'The large room was full of people.';
let defaults: DefaultsDto;
let state: State;
let lexiconInfo: LexiconInfoDto | null = null;

function defaultState(): State {
  return {
    mode: 'mishear',
    text: FIRST_LINE,
    phonemes: 'K IH1 S DH AH0 S K AY1',
    search: { ...defaults.search },
    cost: { ...defaults.cost },
    lexicon: { ...defaults.lexicon },
    autoRun: true,
    sweepKnob: 'search.fit',
    sweepValues: '0, 0.02, 0.05, 0.1, 0.2',
  };
}

/** The settings in the link, or else the saved ones, in the current format. */
function readSaved(): Partial<State> | null {
  try {
    const hash = location.hash.slice(1);
    if (hash) return upgrade(JSON.parse(decodeURIComponent(hash)));
    const current = localStorage.getItem(STORAGE_KEY);
    if (current) return upgrade(JSON.parse(current));
    return upgrade(JSON.parse(localStorage.getItem(OLD_STORAGE_KEY) ?? 'null'));
  } catch {
    return null;
  }
}

/** Saved settings in the current format. (Formats before 3 differed only in
 * deformation, which the page no longer offers.) */
function upgrade(saved: Partial<State> | null): Partial<State> | null {
  if (!saved) return saved;
  if ((saved.v ?? 0) < 3) saved = { ...saved, v: 3 };
  if (saved.v === 3) {
    // Format 3 had one word-prior weight (for both commonness and fit) and
    // a bigrams switch (now fit 0).
    const { lm_weight, bigrams, ...search } = (saved.search ?? {}) as Record<string, unknown>;
    if (typeof lm_weight === 'number') Object.assign(search, { commonness: lm_weight, fit: lm_weight });
    if (bigrams === false) search.fit = 0;
    const sweepKnob = saved.sweepKnob === 'search.lm_weight' ? 'search.fit' : saved.sweepKnob;
    saved = { ...saved, v: 4, search: search as unknown as SearchDto, sweepKnob };
  }
  if (saved.v === 4) saved = { ...saved, v: 5 };
  return saved;
}

function loadState(): State {
  const base = defaultState();
  const saved = readSaved();
  if (!saved) return base;
  // The page no longer deforms lines: drop what earlier formats saved for it.
  const { steps, deform, deformation, soundsOpen, ...kept } = saved as Partial<State> & Record<string, unknown>;
  // Merge over the defaults, so knobs added since are filled in.
  return {
    ...base,
    ...kept,
    // "only within cost" is gone from the page: the top N, always.
    search: { ...base.search, ...unsaved(saved.search), within: base.search.within },
    cost: { ...base.cost, ...unsaved(saved.cost) },
    lexicon: { ...base.lexicon, ...withoutWordLists(unsaved(saved.lexicon)) },
  };
}

/** Lexicon options minus the word lists earlier formats chose between
 * (ENABLE, SCOWL): every word is in now. */
function withoutWordLists(lexicon: Partial<LexiconOptions>): Partial<LexiconOptions> {
  const { common_words, word_list, scowl_level, ...kept } = lexicon as Record<string, unknown>;
  return kept as Partial<LexiconOptions>;
}

/** `state` minus the knobs at their defaults (`null` marks an optional knob turned off). */
function savedState(): Partial<State> {
  const base = defaultState();
  const changed = (values: object, defaults: object) =>
    Object.fromEntries(
      Object.entries({ ...defaults, ...values })
        .filter(([k, v]) => v !== (defaults as Record<string, unknown>)[k])
        .map(([k, v]) => [k, v ?? null]),
    );
  const top = Object.fromEntries(
    Object.entries(state).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(base[k as keyof State])),
  );
  return {
    ...top,
    v: 5,
    search: changed(state.search, base.search) as unknown as SearchDto,
    cost: changed(state.cost, base.cost) as unknown as CostDto,
    lexicon: changed(state.lexicon, base.lexicon) as unknown as LexiconOptions,
  };
}

function saveState(): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(savedState()));
}

/** Undoes `savedState`'s `null`s. */
function unsaved<T extends object>(values: T | undefined): Partial<T> {
  return Object.fromEntries(Object.entries(values ?? {}).map(([k, v]) => [k, v ?? undefined])) as Partial<T>;
}

function groupValues(group: Group): Record<string, unknown> {
  return state[group] as unknown as Record<string, unknown>;
}
function groupDefaults(group: Group): Record<string, unknown> {
  return defaults[group] as unknown as Record<string, unknown>;
}

/** The page hears lines as spoken. */
const NO_DEFORMATION: DeformationDto = { steps: [], intensity: 1, seed: 0 };

/** The input split into lines, each heard on its own. */
function inputLines(): string[] {
  const text = state.mode === 'mishear' ? state.text : state.phonemes;
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function request(text: string): RequestDto {
  return {
    mode: state.mode,
    text,
    deformation: NO_DEFORMATION,
    search: state.search,
    cost: state.cost,
  };
}

// --------------------------------------------------------------- worker ----

const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
let nextId = 1;
const waiting = new Map<number, (m: FromWorker) => void>();

function call(message: ToWorker & { id: number }): Promise<FromWorker> {
  return new Promise((resolve) => {
    waiting.set(message.id, resolve);
    worker.postMessage(message);
  });
}

worker.onmessage = (event: MessageEvent<FromWorker>) => {
  const m = event.data;
  if (m.type === 'status') return setStatus(m.message, true);
  if (m.type === 'ready') return onReady(m);
  if ('id' in m && m.id !== undefined && waiting.has(m.id)) {
    waiting.get(m.id)!(m);
    waiting.delete(m.id);
  } else if (m.type === 'error') {
    setStatus('');
    showError(m.message);
  }
};
worker.onerror = (e) => showError(`The engine worker failed: ${e.message}`);

// ---------------------------------------------------------------- dom ----

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};
const SVG = 'http://www.w3.org/2000/svg';
const svg = (tag: string, attrs: Record<string, string | number>, text?: string): SVGElement => {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  if (text !== undefined) node.textContent = text;
  return node;
};

function setStatus(message: string, busy = false): void {
  const s = $('status');
  s.textContent = message;
  s.classList.toggle('busy', busy);
}
function showError(message: string): void {
  const e = $('error');
  e.textContent = message;
  e.hidden = !message;
}

const fmt = (x: number, digits = 2) => x.toFixed(digits);
const thousands = (x: number) => Math.round(x).toLocaleString('en-US');

/** A knob's ⓘ button, and the technical description it shows and hides. */
function infoToggle(knob: Knob): { button: HTMLButtonElement; text: HTMLParagraphElement } {
  const text = el('p', { className: 'knob-info', textContent: knob.info, hidden: true });
  const button = el('button', { type: 'button', className: 'info', textContent: 'ⓘ', title: 'More detail' });
  button.setAttribute('aria-expanded', 'false');
  button.addEventListener('click', () => {
    text.hidden = !text.hidden;
    button.setAttribute('aria-expanded', String(!text.hidden));
  });
  return { button, text };
}

/** Builds one knob's controls; `onChange(heavy)` fires on every edit. */
function knobControl(group: Group, knob: Knob, onChange: () => void): HTMLElement {
  const values = groupValues(group);
  const def = groupDefaults(group)[knob.key];
  const wrap = el('div', { className: 'knob' });
  const head = el('div', { className: 'knob-head' });
  const reset = el('button', { type: 'button', className: 'reset', textContent: 'reset', title: `Default: ${def ?? 'off'}` });
  const markChanged = () => wrap.classList.toggle('changed', values[knob.key] !== def);
  const info = infoToggle(knob);
  const commit = () => {
    markChanged();
    onChange();
  };

  if (knob.type === 'bool') {
    const box = el('input', { type: 'checkbox', checked: Boolean(values[knob.key]) });
    box.addEventListener('change', () => {
      values[knob.key] = box.checked;
      commit();
    });
    reset.addEventListener('click', () => {
      values[knob.key] = def;
      box.checked = Boolean(def);
      commit();
    });
    head.append(el('label', { className: 'name' }, box, ` ${knob.label}`), info.button, reset);
    wrap.append(head, el('p', { className: 'hint', textContent: knob.hint }), info.text);
    wrap.dataset.key = knob.key;
    markChanged();
    return wrap;
  }

  const optional = knob.onValue !== undefined;
  const current = values[knob.key] as number | undefined;
  const shown = current ?? knob.onValue ?? knob.min;
  const range = el('input', { type: 'range', min: String(knob.min), max: String(knob.max), step: String(knob.step), value: String(shown) });
  const number = el('input', { type: 'number', min: String(knob.min), step: String(knob.step), value: String(shown) });
  const box = el('input', { type: 'checkbox', checked: current !== undefined && current !== null, title: 'on / off' });
  const setValue = (v: number | undefined, from?: HTMLInputElement) => {
    values[knob.key] = v;
    if (v !== undefined) {
      if (from !== range) range.value = String(v);
      if (from !== number) number.value = String(v);
    }
    wrap.classList.toggle('off', optional && v === undefined);
  };
  const read = (input: HTMLInputElement) => {
    let v = Number(input.value);
    if (!Number.isFinite(v)) return;
    if (knob.step >= 1) v = Math.round(v);
    if (optional && !box.checked) box.checked = true;
    setValue(v, input);
  };
  // Light knobs follow the slider; heavy ones apply when it is released.
  range.addEventListener('input', () => {
    number.value = range.value;
    if (!knob.heavy) {
      read(range);
      commit();
    }
  });
  range.addEventListener('change', () => {
    read(range);
    commit();
  });
  number.addEventListener('change', () => {
    read(number);
    commit();
  });
  box.addEventListener('change', () => {
    setValue(box.checked ? Number(number.value) : undefined);
    commit();
  });
  reset.addEventListener('click', () => {
    const d = def as number | undefined | null;
    box.checked = d !== undefined && d !== null;
    setValue(d ?? undefined);
    if (d === undefined || d === null) {
      range.value = number.value = String(knob.onValue);
    }
    commit();
  });
  head.append(el('label', { className: 'name' }, ...(optional ? [box, ' '] : []), knob.label), info.button, reset);
  wrap.append(head, el('div', { className: 'knob-inputs' }, range, number), el('p', { className: 'hint', textContent: knob.hint }), info.text);
  wrap.classList.toggle('off', optional && (current === undefined || current === null));
  wrap.dataset.key = knob.key;
  markChanged();
  return wrap;
}

function renderKnobs(group: Group, knobs: Knob[], container: HTMLElement): void {
  container.replaceChildren(
    ...knobs.map((k) =>
      knobControl(group, k, () => {
        if (group === 'lexicon' && !sameLexicon()) setStatus('The lexicon will rebuild on the next run.');
        changed();
      }),
    ),
  );
}

// -------------------------------------------------------------- results ----

/** One line's hearings, its stats and its alignment grid, which
 * highlights the hearing last clicked. */
function lineBlock(line: string, result: ResultDto, ms: number, rebuildMs: number, several: boolean): HTMLElement {
  const mishear = result.words.length > 0;
  let selected = 0;
  const grid = el('div', { className: 'alignment' });
  const list = el('ol', { className: 'hearings' });
  list.replaceChildren(
    ...result.hearings.map((h, i) => {
      const li = el(
        'li',
        { className: i === selected ? 'selected' : '' },
        el('span', { className: 'text', textContent: h.text }),
        el('span', {
          className: 'meta',
          textContent: [
            `cost ${fmt(h.cost)}`,
            `sound ${fmt(h.phonetic)}`,
            ...(mishear ? [`${h.shared} same word`, `${h.related} same root`] : []),
            ...(i > 0 ? [`${h.reused} reused`] : []),
            ...(result.boundaries.length ? [`crosses ${result.boundaries.length - h.kept} of ${result.boundaries.length} boundaries`] : []),
          ].join(' · '),
          title:
            'cost: sound + cost per word + rarity cost + sense + novelty + same-root + kept boundaries + variety of list. sound: the phonetic part alone. same root: words other than the line’s own that share a stem with one of them. reused: words an earlier hearing in the list used.',
        }),
      );
      li.onclick = () => {
        selected = i;
        list.querySelectorAll('li').forEach((x, k) => x.classList.toggle('selected', k === i));
        grid.querySelectorAll<HTMLElement>('.chip').forEach((c) => c.classList.toggle('selected', c.dataset.row === String(i)));
      };
      return li;
    }),
  );
  if (!result.hearings.length) list.append(el('li', { className: 'hint', textContent: 'Nothing within the bound. Raise “max bound”.' }));
  const s = result.stats;
  const stats = [
    `${result.hearings.length} in ${thousands(ms)} ms`,
    rebuildMs ? `(lexicon rebuilt in ${thousands(rebuildMs)} ms)` : '',
    `bound ${fmt(s.bound, 1)} after ${s.rounds} round${s.rounds === 1 ? '' : 's'}`,
    `${thousands(s.nodes)} trie nodes`,
    `${thousands(s.edges)} edges`,
  ];
  renderAlignment(grid, result, selected);
  const alignment = el(
    'details',
    { className: 'alignment-block', open: alignmentOpen },
    el('summary', { textContent: 'Alignment' }),
    el('div', { className: 'alignment-scroll' }, grid),
  );
  alignment.addEventListener('toggle', () => (alignmentOpen = alignment.open));
  return el(
    'section',
    { className: 'heard-line' },
    ...(several ? [el('h3', { className: 'line-text', textContent: line })] : []),
    list,
    el('p', { className: 'hint', textContent: stats.filter(Boolean).join(' · ') }),
    alignment,
  );
}

/** Whether alignments start open: the last one toggled sets it. */
let alignmentOpen = true;

function renderAlignment(grid: HTMLElement, result: ResultDto, selected: number): void {
  const n = result.input.length;
  grid.style.gridTemplateColumns = `auto repeat(${n}, max-content)`;
  const cells: HTMLElement[] = [];
  const label = (text: string, row: number) => {
    const node = el('div', { className: 'label', textContent: text });
    node.style.gridRow = String(row);
    node.style.gridColumn = '1';
    cells.push(node);
  };
  const place = (node: HTMLElement, row: number, from: number, to: number) => {
    node.style.gridRow = String(row);
    node.style.gridColumn = `${from + 2} / ${Math.max(to, from + 1) + 2}`;
    cells.push(node);
  };
  let row = 1;
  if (result.words.length) {
    label('line', row);
    let at = 0;
    for (const w of result.words) {
      if (w.deformed.length) place(el('div', { className: 'orig-word', textContent: w.text }), row, at, at + w.deformed.length);
      at += w.deformed.length;
    }
    row++;
  }
  label(result.words.length ? 'sounds' : 'input', row);
  result.input.forEach((ph, k) => place(el('div', { className: 'input ph', textContent: ph }), row, k, k + 1));
  row++;
  const lineWords = new Set(result.words.map((w) => w.text));
  const firstHearingRow = row;
  result.hearings.forEach((h, i) => {
    label(`${i + 1}`, row);
    for (const w of h.words) {
      const chip = el('div', {
        className: `chip${lineWords.has(w.text) ? ' shared' : ''}${i === selected ? ' selected' : ''}`,
        textContent: w.text,
        title: result.input.slice(w.start, w.end).join(' '),
      });
      chip.dataset.row = String(i);
      place(chip, row, w.start, w.end);
    }
    row++;
  });
  // The line's word boundaries, drawn over the hearings: a heard word they
  // pass through cuts across one.
  for (const b of result.boundaries) {
    const line = el('div', { className: 'boundary' });
    line.style.gridRow = `1 / ${Math.max(row, firstHearingRow + 1)}`;
    line.style.gridColumn = String(b + 2);
    cells.push(line);
  }
  grid.replaceChildren(...cells);
}

// ---------------------------------------------------------------- sweep ----

function sweepKnobs(): { id: string; label: string; apply: (s: State, v: number) => void }[] {
  const numbered = (group: 'search' | 'cost', knobs: Knob[]) =>
    knobs
      .filter((k): k is NumberKnob => k.type === 'number')
      .map((k) => ({
        id: `${group}.${k.key}`,
        label: `${group}: ${k.label}`,
        apply: (s: State, v: number) => {
          (s[group] as unknown as Record<string, number>)[k.key] = v;
        },
      }));
  return [
    ...numbered('search', SEARCH_KNOBS),
    ...numbered('cost', COST_KNOBS),
  ];
}

function renderSweepControls(): void {
  const select = $<HTMLSelectElement>('sweep-knob');
  select.replaceChildren(...sweepKnobs().map((k) => el('option', { value: k.id, textContent: k.label, selected: k.id === state.sweepKnob })));
  select.onchange = () => {
    state.sweepKnob = select.value;
    saveState();
  };
  const values = $<HTMLInputElement>('sweep-values');
  values.value = state.sweepValues;
  values.onchange = () => {
    state.sweepValues = values.value;
    saveState();
  };
  $('sweep-run').onclick = runSweep;
}

async function runSweep(): Promise<void> {
  const knob = sweepKnobs().find((k) => k.id === state.sweepKnob);
  const values = state.sweepValues
    .split(/[,\s]+/)
    .filter(Boolean)
    .map(Number)
    .filter(Number.isFinite);
  if (!knob || !values.length) return;
  const section = $('sweep-section');
  section.hidden = false;
  $('sweep-title').textContent = `Sweep: ${knob.label}`;
  const columns = values.map((v) => el('div', { className: 'column' }, el('h4', { textContent: `${v}` }), el('p', { className: 'hint', textContent: '…' })));
  $('sweep').replaceChildren(...columns);
  section.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  for (const [k, v] of values.entries()) {
    setStatus(`Sweep ${k + 1} of ${values.length}…`, true);
    const s: State = structuredClone(state);
    knob.apply(s, v);
    const saved = state;
    state = s;
    const req = request(inputLines()[0] ?? '');
    state = saved;
    const reply = await call({ type: 'run', id: nextId++, lexicon: s.lexicon, request: req });
    const column = columns[k];
    if (reply.type === 'error') {
      column.replaceChildren(column.firstChild!, el('p', { className: 'error', textContent: reply.message }));
    } else if (reply.type === 'result') {
      column.replaceChildren(
        column.firstChild!,
        el(
          'ol',
          {},
          ...reply.result.hearings.map((h) => el('li', {}, h.text, el('span', { className: 'cost', textContent: fmt(h.cost) }))),
        ),
        el('p', { className: 'hint', textContent: `${thousands(reply.ms)} ms` }),
      );
    }
  }
  setStatus('');
}

// ------------------------------------------------------------ profiles ----

/** A named set of knob values, kept in this browser. */
interface Profile {
  search: SearchDto;
  cost: CostDto;
  lexicon: LexiconOptions;
}

const PROFILES_KEY = 'mishear-web-profiles-v1';

function readProfiles(): Record<string, Profile> {
  try {
    return JSON.parse(localStorage.getItem(PROFILES_KEY) ?? '{}') ?? {};
  } catch {
    return {};
  }
}

function writeProfiles(profiles: Record<string, Profile>): void {
  localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles));
}

/** The knobs as they stand. */
function currentProfile(): Profile {
  return structuredClone({ search: state.search, cost: state.cost, lexicon: state.lexicon });
}

/** A profile over the current defaults: knobs added since it was saved
 * take their defaults, and knobs since removed are dropped. */
function fullProfile(p: Profile): Profile {
  return {
    search: { ...defaults.search, ...p.search, within: defaults.search.within },
    cost: { ...defaults.cost, ...p.cost },
    lexicon: { ...defaults.lexicon, ...withoutWordLists(p.lexicon ?? {}) },
  };
}

function sameValues(a: object, b: object): boolean {
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  return [...new Set([...Object.keys(x), ...Object.keys(y)])].every((k) => (x[k] ?? null) === (y[k] ?? null));
}

/** Whether the knobs hold the profile's values. */
function holds(p: Profile): boolean {
  const full = fullProfile(p);
  return sameValues(state.search, full.search) && sameValues(state.cost, full.cost) && sameValues(state.lexicon, full.lexicon);
}

/** The profile menu, marking the active profile "(edited)" once the knobs
 * leave its values, and the buttons that apply to it. */
function renderProfiles(): void {
  const profiles = readProfiles();
  if (state.profile !== undefined && !(state.profile in profiles)) state.profile = undefined;
  const active = state.profile;
  const edited = active !== undefined && !holds(profiles[active]);
  const names = Object.keys(profiles).sort((a, b) => a.localeCompare(b));
  $<HTMLSelectElement>('profile').replaceChildren(
    el('option', { value: '', textContent: names.length ? '(no profile)' : '(no profiles yet)', selected: active === undefined }),
    ...names.map((name) => el('option', { value: name, textContent: name === active && edited ? `${name} (edited)` : name, selected: name === active })),
  );
  $<HTMLButtonElement>('profile-save').disabled = active === undefined || !edited;
  $<HTMLButtonElement>('profile-rename').disabled = active === undefined;
  $<HTMLButtonElement>('profile-delete').disabled = active === undefined;
}

/** Sets the knobs to the profile's values. */
function applyProfile(name: string): void {
  const p = fullProfile(readProfiles()[name]);
  state.search = p.search;
  state.cost = p.cost;
  state.lexicon = p.lexicon;
  state.profile = name;
  renderAll();
  changed();
  setStatus(`Applied “${name}”.`);
}

/** Asks for a profile name, `suggested` filled in; `null` if cancelled or
 * declined (an existing name must be confirmed to overwrite). */
function askName(question: string, suggested: string, unless?: string): string | null {
  const name = prompt(question, suggested)?.trim();
  if (!name) return null;
  if (name !== unless && name in readProfiles() && !confirm(`Replace the profile “${name}”?`)) return null;
  return name;
}

function wireProfiles(): void {
  const select = $<HTMLSelectElement>('profile');
  select.onchange = () => {
    if (select.value) applyProfile(select.value);
    else {
      state.profile = undefined;
      saveState();
      renderProfiles();
    }
  };
  $('profile-save').onclick = () => {
    if (state.profile === undefined) return;
    const profiles = readProfiles();
    profiles[state.profile] = currentProfile();
    writeProfiles(profiles);
    renderProfiles();
    setStatus(`Saved “${state.profile}”.`);
  };
  $('profile-save-as').onclick = () => {
    const name = askName('Save these knobs as a profile named:', state.profile ? `${state.profile} 2` : '');
    if (name === null) return;
    const profiles = readProfiles();
    profiles[name] = currentProfile();
    writeProfiles(profiles);
    state.profile = name;
    saveState();
    renderProfiles();
    setStatus(`Saved “${name}”.`);
  };
  $('profile-rename').onclick = () => {
    const old = state.profile;
    if (old === undefined) return;
    const name = askName(`Rename “${old}” to:`, old, old);
    if (name === null || name === old) return;
    const profiles = readProfiles();
    profiles[name] = profiles[old];
    delete profiles[old];
    writeProfiles(profiles);
    state.profile = name;
    saveState();
    renderProfiles();
  };
  $('profile-delete').onclick = () => {
    const name = state.profile;
    if (name === undefined || !confirm(`Delete the profile “${name}”? The knobs keep their values.`)) return;
    const profiles = readProfiles();
    delete profiles[name];
    writeProfiles(profiles);
    state.profile = undefined;
    saveState();
    renderProfiles();
  };
}

// ------------------------------------------------------------- running ----

let lastLexicon: LexiconOptions | null = null;
const sameLexicon = () => same(state.lexicon, lastLexicon);
let timer: number | undefined;
let running = false;
let rerun = false;

function changed(): void {
  saveState();
  renderProfiles();
  if (history.replaceState && location.hash) history.replaceState(null, '', location.pathname);
  if (state.autoRun) {
    clearTimeout(timer);
    timer = window.setTimeout(run, 250);
  }
}

async function run(): Promise<void> {
  clearTimeout(timer);
  if (running) {
    rerun = true;
    return;
  }
  running = true;
  do {
    rerun = false;
    const lines = inputLines();
    if (!lines.length) break;
    const blocks: HTMLElement[] = [];
    let total = 0;
    let notice: string | undefined;
    let failed = false;
    showError('');
    for (const [k, line] of lines.entries()) {
      const what = lines.length > 1 ? `line ${k + 1} of ${lines.length}` : '';
      setStatus(sameLexicon() ? `Hearing${what ? ` ${what}` : ''}…` : 'Rebuilding the lexicon, then hearing…', true);
      const lexicon = structuredClone(state.lexicon);
      const reply = await call({ type: 'run', id: nextId++, lexicon, request: structuredClone(request(line)) });
      if (reply.type === 'result' || reply.type === 'error') lastLexicon = lexicon;
      if (rerun) break; // Stale: the input or knobs moved while it ran.
      if (reply.type === 'error') {
        setStatus('');
        showError(lines.length > 1 ? `Line ${k + 1}: ${reply.message}` : reply.message);
        failed = true;
        break;
      }
      if (reply.type !== 'result') continue;
      lexiconInfo = reply.info;
      engineMemoryMb = reply.memoryMb;
      notice = reply.notice ?? notice;
      total += reply.ms + reply.rebuildMs;
      blocks.push(lineBlock(line, reply.result, reply.ms, reply.rebuildMs, lines.length > 1));
      // Each line shows as soon as it's heard.
      $('heard-section').hidden = false;
      $('heard-lines').replaceChildren(...blocks);
    }
    if (rerun || failed) continue;
    renderLexiconInfo();
    const heard = lines.length > 1 ? `Heard ${lines.length} lines in ${thousands(total)} ms` : `Heard in ${thousands(total)} ms`;
    setStatus(notice ? `${heard}. ${notice}` : heard);
  } while (rerun);
  running = false;
}

let engineMemoryMb = 0;

function renderLexiconInfo(): void {
  if (!lexiconInfo) return;
  const i = lexiconInfo;
  $('lexicon-info').textContent =
    `${thousands(i.words)} words, ${thousands(i.trie_nodes)} trie nodes; ${i.bigrams ? `${thousands(i.bigram_pairs)} word pairs loaded` : 'word-pair counts not loaded'}` +
    (engineMemoryMb ? `; engine memory ${Math.round(engineMemoryMb)} MB.` : '.');
}

// ---------------------------------------------------------------- setup ----

function renderInput(): void {
  const text = $<HTMLTextAreaElement>('text');
  text.value = state.mode === 'mishear' ? state.text : state.phonemes;
  text.placeholder = state.mode === 'mishear' ? 'A line of verse, or several (each is heard on its own)' : 'ARPAbet, e.g. K IH1 S DH AH0 S K AY1 (one line per line)';
  document.querySelectorAll<HTMLInputElement>('input[name="mode"]').forEach((r) => (r.checked = r.value === state.mode));
  $<HTMLInputElement>('auto-run').checked = state.autoRun;
}

function renderAll(): void {
  renderInput();
  renderProfiles();
  renderKnobs('search', SEARCH_KNOBS, $('search-knobs'));
  renderKnobs('cost', COST_KNOBS, $('cost-knobs'));
  renderKnobs('lexicon', LEXICON_KNOBS, $('lexicon-knobs'));
  renderSweepControls();
}

/** Rounds the f32 noise out of numbers from Rust (0.100000001 → 0.1). */
function clean<T>(value: T): T {
  if (typeof value === 'number') return Number(value.toPrecision(6)) as T;
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) (value as Record<string, unknown>)[k] = clean(v);
  }
  return value;
}

function onReady(m: Extract<FromWorker, { type: 'ready' }>): void {
  defaults = clean(m.defaults);
  lexiconInfo = m.info;
  state = loadState();
  lastLexicon = clean(m.lexicon);
  renderAll();
  renderLexiconInfo();
  setStatus(`Loaded in ${thousands(m.loadMs)} ms`);

  const text = $<HTMLTextAreaElement>('text');
  text.addEventListener('input', () => {
    if (state.mode === 'mishear') state.text = text.value;
    else state.phonemes = text.value;
    $('source').textContent = '';
    changed();
  });
  text.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      run();
    }
  });
  document.querySelectorAll<HTMLInputElement>('input[name="mode"]').forEach((r) =>
    r.addEventListener('change', () => {
      state.mode = r.value as Mode;
      renderInput();
      changed();
    }),
  );
  $<HTMLInputElement>('auto-run').addEventListener('change', (e) => {
    state.autoRun = (e.target as HTMLInputElement).checked;
    saveState();
  });
  $('run').onclick = run;
  $('random-line').onclick = () => {
    const pick = LINES[Math.floor(Math.random() * LINES.length)];
    if (!pick) return;
    state.mode = 'mishear';
    state.text = pick.line;
    renderInput();
    $('source').textContent = `— ${pick.poem}`;
    changed();
    if (!state.autoRun) run();
  };
  wireProfiles();
  $('reset-all').onclick = () => {
    const keep = { text: state.text, phonemes: state.phonemes, mode: state.mode };
    state = { ...defaultState(), ...keep };
    renderAll();
    changed();
  };
  $('copy-link').onclick = async () => {
    const url = `${location.origin}${location.pathname}#${encodeURIComponent(JSON.stringify(savedState()))}`;
    await navigator.clipboard.writeText(url);
    setStatus('Link copied.');
  };
  run();
}

setStatus('Starting the engine…', true);
// Build the saved lexicon from the start, so the first run needn't rebuild it.
let savedLexicon: Partial<LexiconOptions> = {};
try {
  savedLexicon = (unsaved(readSaved()?.lexicon) as Partial<LexiconOptions>) ?? {};
} catch {
  /* the defaults, then */
}
worker.postMessage({ type: 'init', lexicon: savedLexicon } satisfies ToWorker);
