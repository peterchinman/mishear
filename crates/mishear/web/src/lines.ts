// Line-sized pieces of The Great Gatsby, for "random line": see
// data/gatsby/README.md.
const text = Object.values(
  import.meta.glob('../../../../data/gatsby/lines.txt', { query: '?raw', import: 'default', eager: true }),
)[0] as string;

export interface SourceLine {
  /** Where the line comes from. */
  source: string;
  line: string;
}

export const LINES: SourceLine[] = text
  .split('\n')
  .filter(Boolean)
  .map((line) => ({ source: 'F. Scott Fitzgerald, The Great Gatsby', line }));
