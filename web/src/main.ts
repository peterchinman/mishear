import './theme';
import type {
  CostDto,
  DeformationDto,
  PronunciationExclusionDto,
  RequestDto,
  SearchDto,
} from 'mishear';
import defaultProfiles from './default-profiles.json';
import { copyText } from './clipboard';
import { SOURCES } from './lines';
import type { FromWorker, LineHearing, LineResult, SettingsDefaults, ToWorker } from './protocol';

// ---------------------------------------------------------------- knobs ----

interface Knob {
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
}
type Group = 'search' | 'cost';

const SEARCH_KNOBS: Knob[] = [
  {
    key: 'familiar',
    label: 'familiar words',
    hint: 'This many of the most common words pay no rarity cost.',
    info: 'The listener’s vocabulary: the lexicon’s most frequent words up to this many pay no rarity cost, and a rarer word pays for how much rarer it is than the last of them. “Rarity cost” sets how steep that edge is.',
    min: 500,
    max: 50000,
    step: 500,
  },
  {
    key: 'commonness',
    label: 'rarity cost',
    hint: 'How strongly common words are preferred over rare ones.',
    info: 'Cost per nat of a word’s rarity, −ln P(word), beyond the familiar words’ rarity. A word twice as rare as the last familiar one pays 0.7 × this; ten times as rare, 2.3 ×. At 0, a rare word costs no more than “the”.',
    min: 0,
    max: 1,
    step: 0.005,
  },
  {
    key: 'fit',
    label: 'sense',
    hint: 'How much each word must make sense after the one before.',
    info: 'Cost per nat of how much less likely a word is after the one before than on its own (a saving when they go together), both measured in Google Books fiction’s word pairs: how much the hearing’s neighbouring words must make sense. 0: words alone (exact, faster, no 29 MB download). Around 0.05 it shapes hearings (“case this guy”); a word’s cost per word + rarity cost + sense never goes below zero.',
    min: 0,
    max: 1,
    step: 0.005,
  },
  { key: 'word_penalty', label: 'cost per word', hint: 'Higher prefers fewer, longer words.', info: 'Added to every heard word’s cost, so it trades many short words against fewer long ones. A word’s cost per word + rarity cost + sense never goes below zero.', min: 0, max: 2, step: 0.01 },
  {
    key: 'novelty',
    label: 'novelty',
    hint: 'Penalty for hearing the line’s own words back, in any form.',
    info: 'Extra cost per heard word that the line already contains, in any form: possessives, plurals and other spellings (“music’s” for “music”, “neighbors” for “neighbour’s”). 0 lets the line hear itself back.',
    min: 0,
    max: 5,
    step: 0.05,
  },
  {
    key: 'root',
    label: 'same-root penalty',
    hint: 'Penalty for words sharing a root with the line’s (“flying” for “fly”).',
    info: 'Extra cost per heard word sharing a stem with a word of the line: “flying” for “fly in”, “flies” for “fly” (Snowball English stemmer, on American spellings). The same word counts too, on top of novelty. Irregular forms (“flew”) aren’t caught.',
    min: 0,
    max: 5,
    step: 0.05,
  },
  {
    key: 'function_share',
    label: 'function-word share',
    hint: 'How much of those penalties small words like “the” pay.',
    info: 'The share of the novelty and same-root costs charged when the line’s word is a function word (the 150 most frequent).',
    min: 0,
    max: 1,
    step: 0.05,
  },
  {
    key: 'crossing',
    label: 'cross word boundaries',
    hint: 'Reward for cutting across the line’s word breaks (“this guy” for “the sky”).',
    info: 'Reward per word boundary of the line that a hearing cuts across (“this guy” for “the sky” cuts the|sky). Charged instead as a cost on each boundary a hearing keeps: that ranks hearings the same way and keeps the search exact, so the costs shown include it.',
    min: 0,
    max: 3,
    step: 0.05,
  },
];

const COST_KNOBS: Knob[] = [
  { key: 'vowel_substitution', label: 'vowel substitution', hint: 'Cost of hearing one vowel as another.', info: 'Cost of hearing one vowel as the farthest-apart other on the vowel chart; nearer vowels cost proportionally less.', min: 0, max: 3, step: 0.05 },
  { key: 'consonant_substitution', label: 'consonant substitution', hint: 'Cost of hearing one consonant as another.', info: 'Cost of hearing one consonant as the most different other, by place, manner, voicing and sibilance; closer consonants cost proportionally less.', min: 0, max: 3, step: 0.05 },
  { key: 'stressed_vowel_indel', label: 'stressed vowel add/drop', hint: 'Cost of adding or dropping a stressed syllable.', info: 'Hearing a stressed vowel (a syllable) that isn’t there, or missing one.', min: 0, max: 3, step: 0.05 },
  { key: 'unstressed_vowel_indel', label: 'unstressed vowel add/drop', hint: 'Cost of adding or dropping an unstressed syllable.', info: 'Hearing an unstressed vowel (mostly a schwa) that isn’t there, or missing one.', min: 0, max: 3, step: 0.05 },
  { key: 'consonant_indel', label: 'consonant add/drop', hint: 'Cost of adding or dropping a consonant.', info: 'Hearing a consonant that isn’t there, or missing one.', min: 0, max: 3, step: 0.05 },
  {
    key: 'stress_mismatch',
    label: 'rhythm (stress mismatch)',
    hint: 'How closely hearings must keep the line’s rhythm.',
    info: 'Extra for hearing a stressed vowel as an unstressed one or the reverse: how closely a hearing must keep the line’s rhythm.',
    min: 0,
    max: 2,
    step: 0.05,
  },
  {
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

// ---------------------------------------------------------------- state ----

interface State {
  /** The saved format: 3 and up save settings as changes from the defaults;
   * 4 has commonness and fit. */
  v?: number;
  text: string;
  search: SearchDto;
  cost: CostDto;
  /** The profile last applied or saved, if any (see "profiles"). */
  profile?: string;
  /** Where "random line" picks from. */
  lineSource?: string;
}

// Only settings changed from their defaults are saved, so a change of default
// reaches everyone who hadn't touched that setting.
const STORAGE_KEY = 'mishear-web-state-v3';
const OLD_STORAGE_KEY = 'mishear-web-state-v2';
let defaults: SettingsDefaults;
let state: State;

function defaultState(): State {
  return {
    text: '',
    ...fullProfile(BUILTIN_PROFILES[BASE_PROFILE]),
    profile: BASE_PROFILE,
  };
}

/** Reads settings from a shared link or local storage. */
function readSaved(): Partial<State> | null {
  try {
    const hash = location.hash.slice(1);
    if (hash) return upgrade(JSON.parse(decodeURIComponent(hash)));
    const stored = localStorage.getItem(STORAGE_KEY) || localStorage.getItem(OLD_STORAGE_KEY);
    const saved = upgrade(JSON.parse(stored ?? 'null'));
    if (saved) delete saved.text;
    return saved;
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
    saved = { ...saved, v: 4, search: search as unknown as SearchDto };
  }
  if (saved.v === 4) saved = { ...saved, v: 5 };
  return saved;
}

function loadState(): State {
  const base = defaultState();
  const saved = readSaved();
  if (!saved) return base;
  const search = editableSearch(unsaved(saved.search));
  const loaded: State = {
    ...base,
    v: saved.v,
    text: singleLine(saved.text ?? base.text),
    search: { ...defaults.search, ...search, familiar: familiarWordCount(search.familiar) },
    cost: { ...defaults.cost, ...unsaved(saved.cost) },
    profile: saved.profile,
    lineSource: saved.lineSource && Object.hasOwn(SOURCES, saved.lineSource) ? saved.lineSource : undefined,
  };
  if (loaded.profile === undefined && sameSettings(loaded, base)) loaded.profile = BASE_PROFILE;
  return loaded;
}

/** Older profiles and links can include engine options the site now fixes. */
function editableSearch(search: Profile['search'] = {}) {
  const { results, within, distinct_sounds, variety, shortlist, beam, max_bound, ...knobs } = search;
  return knobs;
}

/** Settings that differ from the defaults. An explicit `null` turns an optional knob off. */
function savedState(): Omit<Partial<State>, 'text'> {
  const changed = (values: object, defaults: object) =>
    Object.fromEntries(
      Object.entries({ ...defaults, ...values })
        .filter(([k, v]) => v !== (defaults as Record<string, unknown>)[k])
        .map(([k, v]) => [k, v ?? null]),
    );
  return {
    v: 5,
    profile: state.profile,
    lineSource: state.lineSource,
    search: changed(state.search, defaults.search) as unknown as SearchDto,
    cost: changed(state.cost, defaults.cost) as unknown as CostDto,
  };
}

function saveState(): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(savedState()));
}

/** Undoes `savedState`'s `null`s. */
function unsaved<T extends object>(values: T | undefined): Partial<T> {
  return Object.fromEntries(Object.entries(values ?? {}).map(([k, v]) => [k, v ?? undefined])) as Partial<T>;
}

function familiarWordCount(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : defaults.search.familiar ?? 14000;
}

function groupValues(group: Group, settings: ProfileSettings = state): Record<string, unknown> {
  return settings[group] as unknown as Record<string, unknown>;
}

/** The page hears lines as spoken. */
const NO_DEFORMATION: DeformationDto = { steps: [], intensity: 1, seed: 0 };

function singleLine(text: string): string {
  return text.replace(/[\r\n\u2028\u2029]+/g, ' ');
}

function request(text: string, results: number): RequestDto {
  return {
    mode: 'mishear',
    text,
    deformation: NO_DEFORMATION,
    search: { ...state.search, results },
    cost: { ...state.cost },
  };
}

// --------------------------------------------------------------- worker ----

const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
let nextId = 1;
const waiting = new Map<number, (m: FromWorker) => void>();
let workerQueue = Promise.resolve();
let workerFailure: string | undefined;

function call(message: ToWorker & { id: number }): Promise<FromWorker> {
  const job = workerQueue.then(() => new Promise<FromWorker>((resolve) => {
    if (workerFailure) {
      resolve({ type: 'error', id: message.id, message: workerFailure });
      return;
    }
    waiting.set(message.id, resolve);
    worker.postMessage(message);
  }));
  workerQueue = job.then(() => undefined);
  return job;
}

worker.onmessage = (event: MessageEvent<FromWorker>) => {
  const m = event.data;
  if (m.type === 'status') return showEngineStatus(m.message);
  if (m.type === 'ready') return onReady(m);
  if ('id' in m && m.id !== undefined && waiting.has(m.id)) {
    waiting.get(m.id)!(m);
    waiting.delete(m.id);
  } else if (m.type === 'error') {
    showEngineStatus(m.message, true);
  }
};
worker.onerror = (event) => {
  workerFailure = event.message ? `The engine stopped. ${event.message}` : 'The engine stopped.';
  if ($('heard-section').hidden) {
    showEngineStatus(workerFailure, true);
  } else {
    setStatus('');
    showError(workerFailure);
  }
  for (const [id, resolve] of waiting) resolve({ type: 'error', id, message: workerFailure });
  waiting.clear();
};

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
const lineField = $<HTMLTextAreaElement>('text');
const lineFieldFrame = lineField.parentElement!;

function setStatus(message: string, busy = false): void {
  const s = $('status');
  s.textContent = message;
  s.classList.toggle('busy', busy);
  s.hidden = !message;
}

function showEngineStatus(message: string, error = false): void {
  const status = $('engine-status');
  status.textContent = message;
  status.classList.toggle('sr-only', !error);
  status.classList.toggle('error', error);
  status.hidden = !message;
  if (error && lineField.disabled) lineField.removeAttribute('placeholder');
}
function showError(message: string): void {
  const e = $('error');
  e.textContent = message;
  e.hidden = !message;
}


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

/** Builds one knob's controls; `onChange` fires on every edit. */
function knobControl(group: Group, knob: Knob, resetValue: unknown, onChange: () => void): HTMLElement {
  const values = groupValues(group);
  const isFamiliar = group === 'search' && knob.key === 'familiar';
  const wrap = el('div', { className: 'knob' });
  const head = el('div', { className: 'knob-head' });
  const reset = el('button', { type: 'button', className: 'reset', textContent: 'reset', title: `Profile value: ${resetValue ?? 'off'}` });
  reset.setAttribute('aria-label', `Reset ${knob.label}`);
  const markChanged = () => wrap.classList.toggle('changed', (values[knob.key] ?? null) !== (resetValue ?? null));
  const info = infoToggle(knob);
  const commit = () => {
    markChanged();
    onChange();
  };

  const current = values[knob.key] as number | undefined;
  const shown = current ?? knob.onValue ?? knob.min;
  const range = el('input', { type: 'range', min: String(knob.min), max: String(knob.max), step: String(knob.step), value: String(shown) });
  const number = el('input', { type: 'number', min: String(knob.min), step: String(knob.step), value: String(shown) });
  range.setAttribute('aria-label', knob.label);
  number.setAttribute('aria-label', `${knob.label} value`);
  const box = knob.onValue === undefined ? undefined : el('input', {
    type: 'checkbox', checked: current !== undefined && current !== null, title: 'on / off',
  });
  const setValue = (v: number | undefined, from?: HTMLInputElement) => {
    values[knob.key] = v;
    if (v !== undefined) {
      if (from !== range) range.value = String(v);
      if (from !== number) number.value = String(v);
    }
    wrap.classList.toggle('off', box !== undefined && v === undefined);
  };
  const read = (input: HTMLInputElement) => {
    let v = Number(input.value);
    if (!Number.isFinite(v)) return;
    if (knob.step >= 1) v = Math.round(v);
    if (box) box.checked = true;
    const value = isFamiliar ? familiarWordCount(v) : v;
    setValue(value, value === v ? input : undefined);
  };
  const updateRange = () => {
    read(range);
    commit();
  };
  range.addEventListener('input', updateRange);
  range.addEventListener('change', updateRange);
  number.addEventListener('change', () => {
    read(number);
    commit();
  });
  box?.addEventListener('change', () => {
    setValue(box.checked ? Number(number.value) : undefined);
    commit();
  });
  reset.addEventListener('click', () => {
    const value = (resetValue ?? undefined) as number | undefined;
    if (box) box.checked = value !== undefined;
    setValue(value);
    if (value === undefined) {
      range.value = number.value = String(knob.onValue ?? knob.min);
    }
    commit();
  });
  head.append(el('label', { className: 'name' }, ...(box ? [box, ' '] : []), knob.label), info.button, reset);
  wrap.append(head, el('div', { className: 'knob-inputs' }, range, number), el('p', { className: 'hint', textContent: knob.hint }), info.text);
  wrap.classList.toggle('off', box !== undefined && (current === undefined || current === null));
  wrap.dataset.key = knob.key;
  markChanged();
  return wrap;
}

function renderKnobs(group: Group, knobs: Knob[], container: HTMLElement, baseline: ProfileSettings): void {
  const resetValues = groupValues(group, baseline);
  container.replaceChildren(
    ...knobs.map((k) =>
      knobControl(group, k, resetValues[k.key], () => {
        renderProfiles();
        changed();
      }),
    ),
  );
}

// -------------------------------------------------------------- results ----

function renderAlignment(grid: HTMLElement, result: LineResult, heard: LineHearing['words']): void {
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
  label('Line', 1);
  let at = 0;
  for (const word of result.words) {
    const end = at + word.deformed.length;
    if (end > at) place(el('div', { className: 'orig-word', textContent: word.text }), 1, at, end);
    at = end;
  }

  label('Sounds', 2);
  result.input.forEach((ph, k) => place(el('div', { className: 'input ph', textContent: ph }), 2, k, k + 1));

  label('Misheard', 3);
  const lineWords = new Set(result.words.map((word) => word.text));
  for (const word of heard) {
    const chip = el('div', {
      className: lineWords.has(word.text) ? 'chip shared' : 'chip',
      textContent: word.text,
      title: result.input.slice(word.start, word.end).join(' '),
    });
    place(chip, 3, word.start, word.end);
  }
  for (const boundary of result.boundaries) {
    const marker = el('div', { className: 'boundary' });
    marker.style.gridRow = '1 / 4';
    marker.style.gridColumn = String(boundary + 2);
    cells.push(marker);
  }
  grid.replaceChildren(...cells);
}

// ------------------------------------------------------------ profiles ----

/** A named set of knob values, kept in this browser. How many hearings to
 * show ("results") isn't one of them: it stays as it is. */
interface Profile {
  search: Partial<Omit<SearchDto, 'familiar'>> & { familiar?: number | null };
  cost: Partial<Omit<CostDto, 'swap'>> & { swap?: number | null };
}

type ProfileSettings = Pick<State, 'search' | 'cost'>;
const BASE_PROFILE = 'base';
const BUILTIN_PROFILES: Record<string, Profile> = Object.fromEntries(defaultProfiles.map(({ name, ...profile }) => [name, profile]));
const PROFILES_KEY = 'mishear-web-profiles-v1';
const profileMenus = [$<HTMLSelectElement>('profile'), $<HTMLSelectElement>('advanced-profile')];

function isBuiltIn(name: string): boolean {
  return Object.hasOwn(BUILTIN_PROFILES, name);
}

function readCustomProfiles(): Record<string, Profile> {
  try {
    return Object.assign(Object.create(null), JSON.parse(localStorage.getItem(PROFILES_KEY) ?? '{}'));
  } catch {
    return Object.create(null);
  }
}

function readProfiles(): Record<string, Profile> {
  return Object.assign(readCustomProfiles(), BUILTIN_PROFILES);
}

function writeProfiles(profiles: Record<string, Profile>): void {
  const custom = Object.fromEntries(Object.entries(profiles).filter(([name]) => !isBuiltIn(name)));
  localStorage.setItem(PROFILES_KEY, JSON.stringify(custom));
}

/** Bundled names in their defined order, followed by custom names alphabetically. */
function profileNames(profiles: Record<string, Profile>): string[] {
  const custom = Object.keys(profiles).filter((name) => !isBuiltIn(name)).sort((a, b) => a.localeCompare(b));
  return [...Object.keys(BUILTIN_PROFILES), ...custom];
}

/** Preserves edits saved under a bundled name before those profiles became read-only. */
function migrateBundledProfiles(): void {
  const profiles = readCustomProfiles();
  const bundled = Object.keys(profiles).filter(isBuiltIn);
  if (!bundled.length) return;
  const active = state.profile;
  for (const name of bundled) {
    const profile = profiles[name];
    if (!sameSettings(fullProfile(profile), fullProfile(BUILTIN_PROFILES[name]))) {
      const label = `${name} (saved)`;
      let copy = label;
      for (let n = 2; copy in profiles; n++) copy = `${label} ${n}`;
      profiles[copy] = profile;
      if (active === name && sameSettings(state, fullProfile(profile))) state.profile = copy;
    }
    delete profiles[name];
  }
  writeProfiles(profiles);
  if (state.profile !== active && !location.hash) saveState();
}

/** Store the profile knobs. A null preserves an explicit "off". */
function savedProfile({ search, cost }: ProfileSettings): Profile {
  return {
    search: editableSearch(search),
    cost: { ...cost, swap: cost.swap ?? null },
  };
}

/** A profile over the engine defaults, including knobs added since it was saved. */
function fullProfile(p: Profile): ProfileSettings {
  const { familiar, ...search } = editableSearch(p.search);
  const { swap = defaults.cost.swap, ...cost } = p.cost;
  return {
    search: { ...defaults.search, ...search, familiar: familiarWordCount(familiar) },
    cost: { ...defaults.cost, ...cost, swap: swap ?? undefined },
  };
}

function sameValues(a: object, b: object): boolean {
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  return [...new Set([...Object.keys(x), ...Object.keys(y)])].every((k) => (x[k] ?? null) === (y[k] ?? null));
}

function sameSettings(a: ProfileSettings, b: ProfileSettings): boolean {
  return sameValues(a.search, b.search) && sameValues(a.cost, b.cost);
}

/** The profile menus, marking the active profile "(edited)" once the knobs
 * leave its values, and the buttons that apply to it. */
function renderProfiles(): ProfileSettings {
  const profiles = readProfiles();
  if (state.profile !== undefined && !(state.profile in profiles)) state.profile = undefined;
  const active = state.profile;
  const baseline = fullProfile(profiles[active ?? BASE_PROFILE]);
  const edited = active !== undefined && !sameSettings(state, baseline);
  const canEdit = active !== undefined && !isBuiltIn(active);
  const names = profileNames(profiles);
  const selected = active !== undefined && !edited ? active : '';
  for (const menu of profileMenus) {
    // An option must stay mounted through change so the native picker can close.
    const existing = [...menu.options].filter((option) => option.value);
    if (existing.length !== names.length || names.some((name, index) => existing[index].value !== name)) {
      menu.replaceChildren(...names.map((name) => el('option', { value: name, textContent: name })));
    }
    const placeholder = menu.querySelector<HTMLOptionElement>('option[value=""]');
    if (selected) {
      placeholder?.remove();
    } else {
      const label = active === undefined ? 'Custom settings' : `${active} (edited)`;
      if (placeholder) placeholder.textContent = label;
      else menu.prepend(el('option', { value: '', textContent: label, disabled: true }));
    }
    if (menu.value !== selected) menu.value = selected;
  }
  $<HTMLButtonElement>('profile-save').disabled = !canEdit || !edited;
  $<HTMLButtonElement>('profile-rename').disabled = !canEdit;
  $<HTMLButtonElement>('profile-delete').disabled = !canEdit;
  return baseline;
}

/** Sets the knobs to the profile's values. */
function applyProfile(name: string): void {
  const profiles = readProfiles();
  const selected = name in profiles ? name : BASE_PROFILE;
  const p = fullProfile(profiles[selected]);
  state.search = p.search;
  state.cost = p.cost;
  state.profile = selected;
  renderSettings();
  changed();
}

/** Asks for a profile name, `suggested` filled in; `null` if cancelled or
 * declined (an existing name must be confirmed to overwrite). */
function askName(question: string, suggested: string, unless?: string): string | null {
  const name = prompt(question, suggested)?.trim();
  if (!name) return null;
  if (isBuiltIn(name)) {
    $('settings-status').textContent = `“${name}” is a built-in profile. Choose another name.`;
    return null;
  }
  if (name !== unless && name in readProfiles() && !confirm(`Replace the profile “${name}”?`)) return null;
  return name;
}

function wireProfiles(): void {
  for (const menu of profileMenus) {
    menu.onchange = () => {
      if (menu.value) applyProfile(menu.value);
    };
  }
  $('profile-save').onclick = () => {
    if (state.profile === undefined || isBuiltIn(state.profile)) return;
    const profiles = readProfiles();
    profiles[state.profile] = savedProfile(state);
    writeProfiles(profiles);
    renderSettings();
    $('settings-status').textContent = `Saved “${state.profile}”.`;
  };
  $('profile-save-as').onclick = () => {
    const name = askName('Save these knobs as a profile named:', state.profile ? `${state.profile} 2` : '');
    if (name === null) return;
    const profiles = readProfiles();
    profiles[name] = savedProfile(state);
    writeProfiles(profiles);
    state.profile = name;
    saveState();
    renderSettings();
    $('settings-status').textContent = `Saved “${name}”.`;
  };
  $('profile-rename').onclick = () => {
    const old = state.profile;
    if (old === undefined || isBuiltIn(old)) return;
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
    if (name === undefined || isBuiltIn(name) || !confirm(`Delete the profile “${name}”? The knobs keep their values.`)) return;
    const profiles = readProfiles();
    delete profiles[name];
    writeProfiles(profiles);
    state.profile = undefined;
    saveState();
    renderSettings();
  };
}

// ------------------------------------------------------------- running ----

const DEBOUNCE_MS = 350;
const LINE_CHOICES = 5;

interface DisplayedHearing {
  result: LineResult;
  words: LineHearing['words'];
  elapsedMs: number;
  lineChoices?: { hearings: LineHearing[]; elapsedMs: number };
  lineIndex: number;
  wordCycle?: { excluded: PronunciationExclusionDto[]; elapsedMs: number };
  cycling: boolean;
}

let displayed: DisplayedHearing | undefined;
let revision = 0;
let timer: number | undefined;
let hearing = false;
let queued = false;
let copyAttempt = 0;
let copyFeedbackTimer: number | undefined;

function changed(): void {
  state.text = lineField.value;
  saveState();
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  revision++;
  clearTimeout(timer);
  queued = false;
  displayed = undefined;
  $('announcement').textContent = '';
  showError('');
  renderHearing();
  const hasText = Boolean(state.text.trim());
  setStatus(hasText ? 'Finding a mishearing…' : '', hasText);
  if (hasText) timer = window.setTimeout(hearLine, DEBOUNCE_MS);
}

async function hearLine(): Promise<void> {
  if (hearing) {
    queued = true;
    return;
  }
  const line = state.text.trim();
  if (!line) return;
  hearing = true;
  const atRevision = revision;
  try {
    const reply = await call({ type: 'run', id: nextId++, request: request(line, 1) });
    if (revision !== atRevision) return;
    setStatus('');
    if (reply.type === 'error') {
      showError(reply.message);
      return;
    }
    if (reply.type !== 'result') return;
    const first = reply.result.hearings[0];
    if (!first) {
      setStatus('No mishearing found.');
      return;
    }
    displayed = {
      result: reply.result,
      words: first.words,
      elapsedMs: reply.elapsedMs,
      lineIndex: 0,
      cycling: false,
    };
    renderHearing();
  } finally {
    hearing = false;
    if (queued) {
      queued = false;
      void hearLine();
    }
  }
}

function sizeText(element: HTMLElement, text: string, largest: number): void {
  const fraction = Math.max(0, Math.min(1, (text.trim().length - 12) / 168));
  const factor = (1 - fraction) ** 1.6;
  element.style.setProperty('--type-growth', String((largest - 1) * factor));
}

function renderHearing(): void {
  $('heard-section').hidden = !state.text.trim();
  copyAttempt++;
  resetCopyFeedback();
  $<HTMLButtonElement>('copy-result').disabled = !displayed;
  const words = $('heard-words');
  const focusedWord = words.contains(document.activeElement)
    ? (document.activeElement as HTMLButtonElement).dataset.index
    : undefined;
  $<HTMLButtonElement>('cycle-line').disabled =
    !displayed || (displayed.lineChoices?.hearings.length === 1 && !displayed.wordCycle);
  words.hidden = !displayed;
  $('alignment-block').hidden = !displayed;
  const generationTime = $('generation-time');
  generationTime.hidden = !displayed;
  if (!displayed) {
    words.replaceChildren();
    $('alignment').replaceChildren();
    return;
  }
  const { result, words: heard } = displayed;
  const alternatives = displayed.lineIndex > 0 && !displayed.wordCycle ? displayed.lineChoices : undefined;
  const elapsed = Math.round(displayed.wordCycle?.elapsedMs ?? alternatives?.elapsedMs ?? displayed.elapsedMs).toLocaleString();
  generationTime.textContent = `generated in ${elapsed} ms`;
  sizeText(words, heard.map((word) => word.text).join(' '), 4.25);
  words.replaceChildren(...heard.flatMap((word, index) => {
    const button = el('button', { type: 'button', className: 'heard-word', textContent: word.text });
    button.title = 'find another word';
    button.setAttribute('aria-label', `Cycle ${word.text}`);
    button.dataset.index = String(index);
    button.onclick = () => cycleWord(index);
    return index === 0 ? [button] : [' ', button];
  }));
  if (focusedWord !== undefined) {
    const index = Math.min(Number(focusedWord), heard.length - 1);
    words.querySelector<HTMLButtonElement>(`[data-index="${index}"]`)?.focus();
  }
  renderAlignment($('alignment'), result, heard);
}

async function cycleLine(): Promise<void> {
  const model = displayed;
  if (!model || model.cycling) return;
  if (!model.lineChoices) {
    model.cycling = true;
    setStatus('Finding other lines…', true);
    const reply = await call({
      type: 'run', id: nextId++, request: request(state.text.trim(), LINE_CHOICES),
    });
    model.cycling = false;
    if (displayed !== model) return;
    if (reply.type === 'error') {
      setStatus(reply.message);
      return;
    }
    if (reply.type !== 'result') return;
    const first = model.result.hearings[0];
    const seen = new Set([first.text]);
    const rest = reply.result.hearings.filter(({ text }) => {
      if (seen.has(text)) return false;
      seen.add(text);
      return true;
    });
    model.lineChoices = { hearings: [first, ...rest], elapsedMs: reply.elapsedMs };
  }
  const choices = model.lineChoices.hearings;
  if (choices.length < 2 && !model.wordCycle) {
    renderHearing();
    setStatus('No other line found.');
    return;
  }
  model.lineIndex = (model.lineIndex + 1) % choices.length;
  model.words = choices[model.lineIndex].words;
  model.wordCycle = undefined;
  renderHearing();
  announce(model.words.map((word) => word.text).join(' '));
}

async function cycleWord(index: number): Promise<void> {
  const model = displayed;
  if (!model || model.cycling) return;
  const { text: word, start, end, pronunciation } = model.words[index];
  const prior = model.wordCycle?.excluded.filter((x) => x.start < end && start < x.end) ?? [];
  const excluded = [...prior, { start, end, pronunciation, word }];
  const previousText = model.words.map((word) => word.text).join(' ');
  const line = state.text.trim();
  const search = (count: number) => call({
    type: 'run',
    id: nextId++,
    request: { ...request(line, count), excluded_pronunciations: excluded },
  });
  model.cycling = true;
  setStatus('Rehearing the line…', true);
  let reply = await search(1);
  let retryMs = 0;
  if (displayed === model && reply.type === 'result' && reply.result.hearings[0]?.text === previousText) {
    retryMs = reply.elapsedMs;
    reply = await search(LINE_CHOICES);
  }
  model.cycling = false;
  if (displayed !== model) return;
  if (reply.type === 'error') {
    setStatus(reply.message);
    return;
  }
  if (reply.type !== 'result') return;
  const next = reply.result.hearings.find((hearing) => hearing.text !== previousText);
  if (!next) {
    setStatus(`No other mishearing found without “${word}” there.`);
    return;
  }
  model.words = next.words;
  model.wordCycle = { excluded, elapsedMs: retryMs + reply.elapsedMs };
  renderHearing();
  announce(next.text);
}

function announce(message: string): void {
  setStatus('');
  $('announcement').textContent = message;
}

function resetCopyFeedback(): void {
  clearTimeout(copyFeedbackTimer);
  $('copy-result').classList.remove('copied');
  $('copy-fallback').hidden = true;
}

async function copyResult(): Promise<void> {
  if (!displayed) return;
  const text = displayed.words.map((word) => word.text).join(' ');
  const attempt = ++copyAttempt;
  const copied = await copyText(text);
  if (attempt !== copyAttempt) return;
  resetCopyFeedback();
  if (copied) {
    $('copy-result').classList.add('copied');
    $('announcement').textContent = 'Misheard text copied.';
    copyFeedbackTimer = window.setTimeout(resetCopyFeedback, 1600);
    return;
  }
  const field = $<HTMLTextAreaElement>('copy-fallback-text');
  field.value = text;
  $('copy-fallback').hidden = false;
  field.focus();
  field.select();
}

// ---------------------------------------------------------------- setup ----

function renderInput(): void {
  lineField.value = state.text;
  lineFieldFrame.dataset.value = lineField.value;
}

function renderSettings(): void {
  const baseline = renderProfiles();
  renderKnobs('search', SEARCH_KNOBS, $('search-knobs'), baseline);
  renderKnobs('cost', COST_KNOBS, $('cost-knobs'), baseline);
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
  Object.assign(defaults.search, {
    distinct_sounds: true,
    variety: 0.55,
    shortlist: 30,
    beam: 100,
    max_bound: 30,
  } satisfies Partial<SearchDto>);
  state = loadState();
  migrateBundledProfiles();
  renderInput();
  renderSettings();

  const input = lineField;
  input.addEventListener('beforeinput', (event) => {
    if (!event.isComposing && (event.inputType === 'insertLineBreak' || event.inputType === 'insertParagraph')) {
      event.preventDefault();
    }
  });
  input.addEventListener('input', (event) => {
    if ((event as InputEvent).isComposing) lineFieldFrame.dataset.value = input.value;
    else updateText();
  });
  input.addEventListener('compositionend', updateText);
  input.addEventListener('paste', (event) => {
    const pasted = event.clipboardData?.getData('text/plain');
    if (pasted === undefined) return;
    const line = singleLine(pasted);
    if (line === pasted) return;
    event.preventDefault();
    input.setRangeText(line, input.selectionStart, input.selectionEnd, 'end');
    updateText();
  });
  function updateText(): void {
    const value = input.value;
    const text = singleLine(value);
    if (text !== value) {
      const { selectionStart, selectionEnd, selectionDirection } = input;
      input.value = text;
      input.setSelectionRange(
        singleLine(value.slice(0, selectionStart)).length,
        singleLine(value.slice(0, selectionEnd)).length,
        selectionDirection,
      );
    }
    lineFieldFrame.dataset.value = text;
    if (state.text !== input.value) changed();
  }

  const sourceMenu = $<HTMLSelectElement>('line-source');
  sourceMenu.value = state.lineSource ?? 'gatsby';
  for (const select of [sourceMenu, ...profileMenus]) {
    select.addEventListener('pointerdown', () => select.setAttribute('data-pointer-focus', ''));
    const clearPointerFocus = () => select.removeAttribute('data-pointer-focus');
    select.addEventListener('pointercancel', clearPointerFocus);
    select.addEventListener('blur', clearPointerFocus);
    select.addEventListener('keydown', clearPointerFocus);
  }
  sourceMenu.onchange = () => {
    state.lineSource = sourceMenu.value;
    saveState();
  };
  $('random-line').onclick = () => {
    const lines = SOURCES[state.lineSource ?? 'gatsby'];
    const line = lines[Math.floor(Math.random() * lines.length)];
    if (!line) return;
    state.text = line;
    renderInput();
    changed();
  };
  wireProfiles();
  $('reset-all').onclick = () => applyProfile(state.profile ?? BASE_PROFILE);
  $('copy-link').onclick = async () => {
    const shared = { ...savedState(), text: state.text || undefined };
    const url = `${location.origin}${location.pathname}${location.search}#${encodeURIComponent(JSON.stringify(shared))}`;
    $('settings-status').textContent = await copyText(url) ? 'Link copied.' : 'Could not copy link.';
  };
  for (const control of [input, ...profileMenus, $('random-line'), sourceMenu]) control.removeAttribute('disabled');
  input.placeholder = 'Type a line to hear it wrong';
  showEngineStatus('');
  if (document.activeElement === document.body) input.focus({ preventScroll: true });
  if (state.text.trim()) {
    renderHearing();
    setStatus('Finding a mishearing…', true);
    void hearLine();
  }
}

$('cycle-line').onclick = cycleLine;
$('copy-result').onclick = copyResult;
$('close-copy-fallback').onclick = () => {
  resetCopyFeedback();
  $('copy-result').focus();
};
const controls = $('controls');
const advancedToggle = $('advanced');
const closeAdvanced = $('close-advanced');
const compactLayout = matchMedia('(max-width: 52rem)');

function setAdvanced(open: boolean): void {
  controls.hidden = !open;
  advancedToggle.setAttribute('aria-expanded', String(open));
  document.querySelector('main')?.classList.toggle('advanced-open', open);
}

advancedToggle.onclick = () => {
  const open = controls.hidden;
  setAdvanced(open);
  if (open && compactLayout.matches) closeAdvanced.focus();
};
closeAdvanced.onclick = () => {
  setAdvanced(false);
  advancedToggle.focus();
};

compactLayout.addEventListener('change', () => {
  if (controls.hidden) return;
  if (compactLayout.matches && $('workspace').contains(document.activeElement)) closeAdvanced.focus();
  if (!compactLayout.matches && document.activeElement === closeAdvanced) advancedToggle.focus();
});

worker.postMessage({ type: 'init' } satisfies ToWorker);
