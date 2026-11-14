// Messages between the page and the engine worker.
import type { DefaultsDto, LexiconInfoDto, LexiconOptions, RequestDto, ResultDto } from 'mishear';

export type ToWorker =
  /** Starts the engine with these lexicon options over the defaults. */
  | { type: 'init'; lexicon: Partial<LexiconOptions> }
  | { type: 'run'; id: number; lexicon: LexiconOptions; request: RequestDto };

export type FromWorker =
  | { type: 'status'; message: string }
  | {
      type: 'ready';
      defaults: DefaultsDto;
      info: LexiconInfoDto;
      /** The lexicon options it was built with. */
      lexicon: LexiconOptions;
      loadMs: number;
    }
  | {
      type: 'result';
      id: number;
      result: ResultDto;
      ms: number;
      info: LexiconInfoDto;
      rebuildMs: number;
      /** The engine's memory, in MB. */
      memoryMb: number;
      /** Something the page should say, such as missing word-pair counts. */
      notice?: string;
    }
  | { type: 'error'; id?: number; message: string };

export function sameLexicon(a: LexiconOptions | null, b: LexiconOptions | null): boolean {
  return (
    a !== null &&
    b !== null &&
    a.vocabulary === b.vocabulary &&
    a.all_pronunciations === b.all_pronunciations &&
    a.word_list === b.word_list &&
    (a.word_list !== 'scowl' || a.scowl_level === b.scowl_level) &&
    a.bigram_prior === b.bigram_prior
  );
}
