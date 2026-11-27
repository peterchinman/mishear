// Build the lexicon and run searches off the main thread.
import init, { MishearApp, defaults, type LexiconOptions, type RequestDto } from 'mishear';
import type { FromWorker, LineHearing, LineResult, ToWorker } from './protocol';

const post = (message: FromWorker) => self.postMessage(message);

let app: MishearApp | null = null;
let data = '';
let bigrams: 'unloaded' | 'loaded' | 'missing' = 'unloaded';
const LEXICON_OPTIONS: LexiconOptions = {
  vocabulary: 100_000,
  all_pronunciations: true,
  bigram_prior: 100_000,
};

/** Word-pair counts are big: fetched when first needed, packed and gzipped
 * (else as text). Without them the engine scores words alone. */
async function ensureBigrams(): Promise<void> {
  if (bigrams !== 'unloaded' || !app) return;
  const bytes = (await fetchGzipped(data + 'bigrams-en.bin.gz')) ?? (await fetchBytes(data + 'bigrams-en.tsv'));
  if (bytes === undefined) {
    bigrams = 'missing';
    return;
  }
  app.loadBigrams(bytes);
  bigrams = 'loaded';
}

async function fetchBytes(url: string): Promise<Uint8Array | undefined> {
  const res = await fetch(url);
  return res.ok ? new Uint8Array(await res.arrayBuffer()) : undefined;
}

/** A gzipped file, unzipped as it arrives (unless the server already did,
 * by Content-Encoding). */
async function fetchGzipped(url: string): Promise<Uint8Array | undefined> {
  const res = await fetch(url);
  if (!res.ok || !res.body) return undefined;
  const [peek, body] = res.body.tee();
  const first = await peek.getReader().read();
  const gzipped = first.value !== undefined && first.value[0] === 0x1f && first.value[1] === 0x8b;
  const stream = gzipped ? body.pipeThrough(new DecompressionStream('gzip')) : body;
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function fetchText(url: string, required: boolean): Promise<string | undefined> {
  const res = await fetch(url);
  if (res.ok) return res.text();
  if (required) throw new Error(`${url}: HTTP ${res.status} (run \`npm run data\`)`);
  return undefined;
}

async function start(): Promise<void> {
  post({ type: 'status', message: 'Loading the engine…' });
  await init();
  data = import.meta.env.BASE_URL + 'data/';
  const [dict, frequencies, variants] = await Promise.all([
    fetch(data + 'cmudict-0.7b').then((r) => {
      if (!r.ok) throw new Error(`${data}cmudict-0.7b: HTTP ${r.status} (run \`npm run data\`)`);
      return r.arrayBuffer();
    }),
    fetchText(data + 'wordfreq-en.tsv', true),
    fetchText(data + 'varcon-to-american.tsv', false),
  ]);
  post({ type: 'status', message: 'Building the lexicon…' });
  app = new MishearApp(new Uint8Array(dict), frequencies ?? '', undefined, LEXICON_OPTIONS);
  if (variants !== undefined) app.setSpellingVariants(variants);
  const { search, cost } = defaults();
  post({ type: 'ready', defaults: { search, cost } });
}

/** Search long passages in short phrases so each phrase has its own cost bound. */
function runLine(engine: MishearApp, request: RequestDto): LineResult {
  const tokens = request.text.split(/\s+/).filter(Boolean);
  const phraseSize = 12;
  if (request.mode !== 'mishear' || tokens.length <= phraseSize) return engine.run(request);

  const line: LineResult = { words: [], input: [], boundaries: [], hearings: [] };
  const phrases: LineHearing[][] = [];
  for (let start = 0; start < tokens.length;) {
    let end = Math.min(start + phraseSize, tokens.length);
    if (end < tokens.length) {
      for (let i = end; i >= start + 6; i--) {
        if (/[.!?;:,]["'”’)]*$/.test(tokens[i - 1])) {
          end = i;
          break;
        }
      }
    }
    const offset = line.input.length;
    const { starting_sound } = request.search;
    const result = engine.run({
      ...request,
      text: tokens.slice(start, end).join(' '),
      search: typeof starting_sound === 'number'
        ? { ...request.search, starting_sound: (starting_sound + offset) >>> 0 }
        : request.search,
      excluded_pronunciations: request.excluded_pronunciations
        ?.filter((exclusion) => exclusion.start >= offset)
        .map((exclusion) => ({ ...exclusion, start: exclusion.start - offset, end: exclusion.end - offset })),
    });
    if (!result.hearings.length) return line;
    if (offset) line.boundaries.push(offset);
    line.boundaries.push(...result.boundaries.map((boundary) => boundary + offset));
    line.words.push(...result.words);
    line.input.push(...result.input);
    phrases.push(result.hearings.map(({ text, words }) => ({
      text,
      words: words.map((word) => ({ ...word, start: word.start + offset, end: word.end + offset })),
    })));
    start = end;
  }

  const count = Math.max(...phrases.map((phrase) => phrase.length));
  for (let index = 0; index < count; index++) {
    const parts = phrases.map((phrase) => phrase[index % phrase.length]);
    line.hearings.push({
      text: parts.map((part) => part.text).join(' '),
      words: parts.flatMap((part) => part.words),
    });
  }
  return line;
}

self.onmessage = async (event: MessageEvent<ToWorker>) => {
  const message = event.data;
  try {
    if (message.type === 'init') {
      await start();
      return;
    }
    if (!app) throw new Error('the engine is not loaded yet');
    if (message.request.search.fit > 0) await ensureBigrams();
    const started = performance.now();
    const result = runLine(app, message.request);
    post({ type: 'result', id: message.id, result, elapsedMs: performance.now() - started });
  } catch (err) {
    post({
      type: 'error',
      id: 'id' in message ? message.id : undefined,
      message: String(err instanceof Error ? err.message : err),
    });
  }
};
