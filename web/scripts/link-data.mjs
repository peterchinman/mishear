// Links the engine's data into public/data so the dev server and the build
// serve it: CMUdict and VarCon's spelling variants (committed), and the
// generated word-frequency list and word-pair counts under data/. The page
// uses the published gzip as-is or gzips a locally packed model.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, '../public/data');
const packed = '../../data/bigrams-en.bin';
const model = fs.existsSync(path.resolve(here, packed)) ? packed : `${packed}.gz`;
fs.mkdirSync(out, { recursive: true });

/** Removes a file or link, dangling links included. */
const remove = (p) => {
  try {
    fs.unlinkSync(p);
  } catch {
    /* not there */
  }
};

const files = [
  ['cmudict-0.7b', '../../data/CMUdict/cmudict-0.7b', true],
  ['wordfreq-en.tsv', '../../data/wordfreq-en.tsv', true],
  ['bigrams-en.tsv', '../../data/bigrams-en.tsv', false],
  ['bigrams-en.bin.gz', model, false],
  ['varcon-to-american.tsv', '../../data/VarCon/varcon-to-american.tsv', true],
  // VarCon's notices travel with it.
  ['varcon-LICENSE.txt', '../../data/VarCon/LICENSE', true],
  // CMUdict's license travels with it.
  ['cmudict-LICENSE.txt', '../../data/CMUdict/LICENSE', true],
];
for (const [name, source, required] of files) {
  const from = path.isAbsolute(source) ? source : path.resolve(here, source);
  const to = path.join(out, name);
  if (!fs.existsSync(from)) {
    remove(to); // no stale link to a file that's gone
    if (required) {
      console.error(`missing ${from}: see README.md, "Setup"`);
      process.exit(1);
    }
    console.warn(`skipping ${name}: ${from} not found`);
    continue;
  }
  if (source === packed) {
    // Compressed once, and again only when the source changes.
    if (!fs.existsSync(to) || fs.lstatSync(to).isSymbolicLink() || fs.statSync(to).mtimeMs < fs.statSync(from).mtimeMs) {
      console.log(`gzipping ${from}…`);
      remove(to);
      fs.writeFileSync(to, zlib.gzipSync(fs.readFileSync(from), { level: 9 }));
    }
    continue;
  }
  remove(to);
  fs.symlinkSync(from, to);
}
console.log(`linked data into ${out}`);
