// Lines for "random line": sentences of The Great Gatsby and proverbial
// phrases (see data/gatsby/README.md and data/proverbs/README.md).
const raw = import.meta.glob(['../../../../data/gatsby/lines.txt', '../../../../data/proverbs/lines.txt'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const read = (dir: string): string[] =>
  (Object.entries(raw).find(([path]) => path.includes(`/data/${dir}/`))?.[1] ?? '').split('\n').filter(Boolean);

export interface LineSource {
  /** What the source is called in the menu. */
  label: string;
  /** Shown under the line once it's picked. */
  credit: string;
  lines: string[];
}

export const SOURCES: Record<string, LineSource> = {
  gatsby: {
    label: 'Gatsby',
    credit: 'F. Scott Fitzgerald, The Great Gatsby',
    lines: read('gatsby'),
  },
  proverbs: {
    label: 'proverbs',
    credit: 'a proverbial phrase',
    lines: read('proverbs'),
  },
};
