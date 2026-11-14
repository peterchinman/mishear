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
  heavy?: boolean;
}
interface ChoiceKnob {
  type: 'choice';
  key: string;
  label: string;
  hint: string;
  options: { value: string; label: string }[];
  heavy?: boolean;
}
type Knob = NumberKnob | BoolKnob | ChoiceKnob;
type Group = 'search' | 'cost' | 'lexicon';

const SEARCH_KNOBS: Knob[] = [
  { type: 'number', key: 'results', label: 'results', hint: 'How many hearings to return: the exact top N.', min: 1, max: 50, step: 1 },
  {
    type: 'number',
    key: 'within',
    label: 'only within cost',
    hint: 'Return hearings costing at most this (up to N of them), exactly. Faster; may return fewer. Off: the bound starts at 2 and rises until N are found.',
    min: 0.5,
    max: 15,
    step: 0.1,
    onValue: 4,
  },
  {
    type: 'number',
    key: 'commonness',
    label: 'commonness',
    hint: 'Cost per nat of a word’s rarity, −ln P(word): how much common words are preferred. 0: a rare word costs no more than “the”; higher: common words win (at 0.3, hearings collapse into words like “information”).',
    min: 0,
    max: 0.5,
    step: 0.005,
  },
  {
    type: 'number',
    key: 'fit',
    label: 'fit',
    hint: 'Cost per nat of how much less likely a word is after the one before than on its own (a saving when they go together), both measured in Google Books fiction’s word pairs: how much the hearing’s neighbouring words must make sense. 0: words alone (exact, faster, no 29 MB download). Around 0.05 it shapes hearings (“case this guy”); a word’s penalty + commonness + fit never goes below zero.',
    min: 0,
    max: 0.5,
    step: 0.005,
  },
  { type: 'number', key: 'word_penalty', label: 'word penalty', hint: 'Cost per word. Higher prefers fewer, longer words.', min: 0, max: 2, step: 0.01 },
  {
    type: 'number',
    key: 'shortlist',
    label: 'bigram shortlist',
    hint: 'With fit above 0: words kept per input span before the previous word is known. The search is exact only up to it.',
    min: 5,
    max: 200,
    step: 1,
  },
  {
    type: 'number',
    key: 'beam',
    label: 'bigram beam',
    hint: 'With fit above 0: partial hearings kept per position. Wider is closer to exact and slower. At a small fit, narrow costs nothing; at 0.1, 50 makes a few hearings slightly worse than 400.',
    min: 10,
    max: 400,
    step: 10,
  },
  {
    type: 'bool',
    key: 'distinct_sounds',
    label: 'merge same-sound hearings',
    hint: 'Treat hearings that sound alike (“there” / “their”) as one, keeping the cheapest spelling. Off: list every spelling.',
  },
  {
    type: 'number',
    key: 'novelty',
    label: 'novelty',
    hint: 'Extra cost per heard word that the line already contains, in any form: possessives, plurals and other spellings (“music’s” for “music”, “neighbors” for “neighbour’s”). 0 lets the line hear itself back.',
    min: 0,
    max: 5,
    step: 0.05,
  },
  {
    type: 'number',
    key: 'variety',
    label: 'variety',
    hint: 'Extra cost per word an earlier hearing in the list used, in any form (“arrive” after “arrives”), or a homophone of one (“cents” after “sense”), as novelty does for the line’s own words. Each hearing is then the best one given those above it, so the list varies. 0: the plain top N, which often differ by a word. With bigrams on, it slows the search several-fold.',
    min: 0,
    max: 5,
    step: 0.05,
  },
  {
    type: 'number',
    key: 'root',
    label: 'same-root penalty',
    hint: 'Extra cost per heard word sharing a stem with a word of the line: “flying” for “fly in”, “flies” for “fly” (Snowball English stemmer, on American spellings). The same word counts too, on top of novelty. Irregular forms (“flew”) aren’t caught.',
    min: 0,
    max: 5,
    step: 0.05,
  },
  {
    type: 'number',
    key: 'function_share',
    label: 'function-word share',
    hint: 'The share of the novelty and same-root costs charged when the line’s word is a function word (the 150 most frequent).',
    min: 0,
    max: 1,
    step: 0.05,
  },
  {
    type: 'number',
    key: 'crossing',
    label: 'cross word boundaries',
    hint: 'Reward per word boundary of the line that a hearing cuts across (“this guy” for “the sky” cuts the|sky). Charged instead as a cost on each boundary a hearing keeps: that ranks hearings the same way and keeps the search exact, so the costs shown include it.',
    min: 0,
    max: 3,
    step: 0.05,
  },
  { type: 'number', key: 'max_bound', label: 'max bound', hint: 'How far the top-N search may raise its bound before it settles for fewer.', min: 2, max: 60, step: 0.5 },
];

const COST_KNOBS: Knob[] = [
  { type: 'number', key: 'vowel_substitution', label: 'vowel substitution', hint: 'Cost of hearing one vowel as the farthest-apart other; nearer vowels cost proportionally less.', min: 0, max: 3, step: 0.05 },
  { type: 'number', key: 'consonant_substitution', label: 'consonant substitution', hint: 'The same for consonants.', min: 0, max: 3, step: 0.05 },
  { type: 'number', key: 'stressed_vowel_indel', label: 'stressed vowel add/drop', hint: 'Hearing a stressed vowel (a syllable) that isn’t there, or missing one.', min: 0, max: 3, step: 0.05 },
  { type: 'number', key: 'unstressed_vowel_indel', label: 'unstressed vowel add/drop', hint: 'The same for an unstressed vowel (mostly a schwa).', min: 0, max: 3, step: 0.05 },
  { type: 'number', key: 'consonant_indel', label: 'consonant add/drop', hint: 'Hearing a consonant that isn’t there, or missing one.', min: 0, max: 3, step: 0.05 },
  {
    type: 'number',
    key: 'stress_mismatch',
    label: 'rhythm (stress mismatch)',
    hint: 'Extra for hearing a stressed vowel as an unstressed one or the reverse: how closely a hearing must keep the line’s rhythm.',
    min: 0,
    max: 2,
    step: 0.05,
  },
  {
    type: 'number',
    key: 'swap',
    label: 'adjacent swap',
    hint: 'Hearing two adjacent consonants swapped (“ask” ↔ “aks”) as one edit at this cost. Off: no swaps.',
    min: 0,
    max: 2,
    step: 0.05,
    onValue: 0.5,
  },
];

const LEXICON_KNOBS: Knob[] = [
  { type: 'number', key: 'vocabulary', label: 'vocabulary', hint: 'The most frequent words kept. Changing it rebuilds the lexicon.', min: 1000, max: 100000, step: 1000, heavy: true },
  { type: 'bool', key: 'all_pronunciations', label: 'every pronunciation', hint: 'Every CMUdict pronunciation of a word, or only the first.', heavy: true },
  {
    type: 'choice',
    key: 'word_list',
    label: 'word list',
    hint: 'Which words hearings may use, besides contractions and possessives of them (“it’s”, “people’s”). ENABLE: a Scrabble list, no names, brands or abbreviations, but words like “qi” and “haar”. SCOWL: a spell-checker list graded by commonness, kept up to the level below; names, places, days and months, no abbreviations. Every word: whatever is frequent enough. SCOWL and every word drop single letters but “a” and “I”, and words said as their letters (“TV”, “UK”).',
    options: [
      { value: 'enable', label: 'ENABLE' },
      { value: 'scowl', label: 'SCOWL' },
      { value: 'none', label: 'every word' },
    ],
    heavy: true,
  },
  {
    type: 'number',
    key: 'scowl_level',
    label: 'SCOWL level',
    hint: 'With the SCOWL list: how rare a word may be. 35: common words; 50: a small dictionary’s; 60: a large one’s; 70–80: rare and obscure words (“haar”, “qi”).',
    min: 10,
    max: 80,
    step: 5,
    heavy: true,
  },
  {
    type: 'number',
    key: 'bigram_prior',
    label: 'bigram smoothing μ',
    hint: 'Dirichlet smoothing: how far a rarely seen word pair falls back on the single-word frequency. The Google Books counts run to billions, so this is large; scores on held-out text barely change between 10,000 and 1,000,000.',
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
  if (saved.v === 4) {
    // Format 4 had an "ENABLE words only" switch; off kept every word.
    const { common_words, ...lexicon } = (saved.lexicon ?? {}) as Record<string, unknown>;
    if (common_words === false) lexicon.word_list = 'none';
    saved = { ...saved, v: 5, lexicon: lexicon as unknown as LexiconOptions };
  }
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
    search: { ...base.search, ...unsaved(saved.search) },
    cost: { ...base.cost, ...unsaved(saved.cost) },
    lexicon: { ...base.lexicon, ...unsaved(saved.lexicon) },
  };
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

function request(): RequestDto {
  return {
    mode: state.mode,
    text: state.mode === 'mishear' ? state.text : state.phonemes,
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

/** Builds one knob's controls; `onChange(heavy)` fires on every edit. */
function knobControl(group: Group, knob: Knob, onChange: () => void): HTMLElement {
  const values = groupValues(group);
  const def = groupDefaults(group)[knob.key];
  const wrap = el('div', { className: 'knob' });
  const head = el('div', { className: 'knob-head' });
  const reset = el('button', { type: 'button', className: 'reset', textContent: 'reset', title: `Default: ${def ?? 'off'}` });
  const markChanged = () => wrap.classList.toggle('changed', values[knob.key] !== def);
  const commit = () => {
    markChanged();
    onChange();
  };

  if (knob.type === 'choice') {
    const select = el('select', {});
    for (const option of knob.options) {
      select.append(el('option', { value: option.value, textContent: option.label, selected: values[knob.key] === option.value }));
    }
    select.addEventListener('change', () => {
      values[knob.key] = select.value;
      commit();
    });
    reset.addEventListener('click', () => {
      values[knob.key] = def;
      select.value = String(def);
      commit();
    });
    head.append(el('label', { className: 'name' }, `${knob.label} `, select), reset);
    wrap.append(head, el('p', { className: 'hint', textContent: knob.hint }));
    wrap.dataset.key = knob.key;
    markChanged();
    return wrap;
  }

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
    head.append(el('label', { className: 'name' }, box, ` ${knob.label}`), reset);
    wrap.append(head, el('p', { className: 'hint', textContent: knob.hint }));
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
  head.append(el('label', { className: 'name' }, ...(optional ? [box, ' '] : []), knob.label), reset);
  wrap.append(head, el('div', { className: 'knob-inputs' }, range, number), el('p', { className: 'hint', textContent: knob.hint }));
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
  if (group === 'lexicon' && lexiconInfo) {
    const missing: Record<string, boolean> = { enable: !lexiconInfo.enable_available, scowl: !lexiconInfo.scowl_available };
    for (const option of container.querySelectorAll<HTMLOptionElement>('[data-key="word_list"] option')) {
      if (missing[option.value]) {
        option.disabled = true;
        option.title = 'Its word list wasn’t found (see `npm run data`).';
      }
    }
  }
}

// -------------------------------------------------------------- results ----

let selectedHearing = 0;
let lastResult: ResultDto | null = null;

function renderResult(result: ResultDto, ms: number, rebuildMs: number): void {
  lastResult = result;
  showError('');
  const mishear = result.words.length > 0;
  // Hearings.
  $('heard-section').hidden = false;
  selectedHearing = Math.min(selectedHearing, Math.max(0, result.hearings.length - 1));
  const list = $('hearings');
  list.replaceChildren(
    ...result.hearings.map((h, i) => {
      const li = el(
        'li',
        { className: i === selectedHearing ? 'selected' : '' },
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
            'cost: sound + word prior + word penalty + novelty + same-root + kept boundaries + variety. sound: the phonetic part alone. same root: words other than the line’s own that share a stem with one of them. reused: words an earlier hearing in the list used.',
        }),
      );
      li.onclick = () => {
        selectedHearing = i;
        list.querySelectorAll('li').forEach((x, k) => x.classList.toggle('selected', k === i));
        $('alignment')
          .querySelectorAll<HTMLElement>('.chip')
          .forEach((c) => c.classList.toggle('selected', c.dataset.row === String(i)));
      };
      return li;
    }),
  );
  if (!result.hearings.length) list.append(el('li', { className: 'hint', textContent: 'Nothing within the bound. Raise “max bound” or “only within cost”.' }));
  const s = result.stats;
  const parts = [
    `${result.hearings.length} in ${thousands(ms)} ms`,
    rebuildMs ? `(lexicon rebuilt in ${thousands(rebuildMs)} ms)` : '',
    `bound ${fmt(s.bound, 1)} after ${s.rounds} round${s.rounds === 1 ? '' : 's'}`,
    `${thousands(s.nodes)} trie nodes`,
    `${thousands(s.edges)} edges`,
  ];
  $('stats').textContent = parts.filter(Boolean).join(' · ');
  renderAlignment(result);
}

function renderAlignment(result: ResultDto): void {
  const grid = $('alignment');
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
        className: `chip${lineWords.has(w.text) ? ' shared' : ''}${i === selectedHearing ? ' selected' : ''}`,
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
    const req = request();
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

// ------------------------------------------------------------- running ----

let lastLexicon: LexiconOptions | null = null;
const sameLexicon = () => same(state.lexicon, lastLexicon);
let timer: number | undefined;
let running = false;
let rerun = false;

function changed(): void {
  saveState();
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
    const text = state.mode === 'mishear' ? state.text : state.phonemes;
    if (!text.trim()) break;
    setStatus(sameLexicon() ? 'Hearing…' : 'Rebuilding the lexicon, then hearing…', true);
    const lexicon = structuredClone(state.lexicon);
    const reply = await call({ type: 'run', id: nextId++, lexicon, request: structuredClone(request()) });
    if (reply.type === 'result') lastLexicon = lexicon;
    if (rerun) continue; // Stale: the knobs moved while it ran.
    if (reply.type === 'result') {
      lexiconInfo = reply.info;
      engineMemoryMb = reply.memoryMb;
      renderLexiconInfo();
      renderResult(reply.result, reply.ms, reply.rebuildMs);
      setStatus(reply.notice ? `Heard in ${thousands(reply.ms)} ms. ${reply.notice}` : `Heard in ${thousands(reply.ms)} ms`);
    } else if (reply.type === 'error') {
      lastLexicon = lexicon;
      setStatus('');
      showError(reply.message);
    }
  } while (rerun);
  running = false;
}

let engineMemoryMb = 0;

function renderLexiconInfo(): void {
  if (!lexiconInfo) return;
  const i = lexiconInfo;
  $('lexicon-info').textContent =
    `${thousands(i.words)} words, ${thousands(i.trie_nodes)} trie nodes; ${i.bigrams ? `${thousands(i.bigram_pairs)} word pairs loaded` : 'word-pair counts not loaded'}; ` +
    `ENABLE ${i.enable_available ? 'loaded' : 'not found'}, SCOWL ${i.scowl_available ? 'loaded' : 'not found'}` +
    (engineMemoryMb ? `; engine memory ${Math.round(engineMemoryMb)} MB.` : '.');
}

// ---------------------------------------------------------------- setup ----

function renderInput(): void {
  const text = $<HTMLTextAreaElement>('text');
  text.value = state.mode === 'mishear' ? state.text : state.phonemes;
  text.placeholder = state.mode === 'mishear' ? 'A line of verse' : 'ARPAbet, e.g. K IH1 S DH AH0 S K AY1';
  document.querySelectorAll<HTMLInputElement>('input[name="mode"]').forEach((r) => (r.checked = r.value === state.mode));
  $<HTMLInputElement>('auto-run').checked = state.autoRun;
}

function renderAll(): void {
  renderInput();
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
