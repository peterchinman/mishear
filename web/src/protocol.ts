// Messages between the page and the engine worker.
import type { DefaultsDto, HearingDto, RequestDto, ResultDto } from 'mishear';

export type SettingsDefaults = Pick<DefaultsDto, 'search' | 'cost'>;
export type LineHearing = Pick<HearingDto, 'text' | 'words'>;
export type LineResult = Pick<ResultDto, 'words' | 'input' | 'boundaries'> & { hearings: LineHearing[] };

export type ToWorker =
  | { type: 'init' }
  | { type: 'run'; id: number; request: RequestDto };

export type FromWorker =
  | { type: 'status'; message: string }
  | { type: 'ready'; defaults: SettingsDefaults }
  | { type: 'result'; id: number; result: LineResult; elapsedMs: number }
  | { type: 'error'; id?: number; message: string };
