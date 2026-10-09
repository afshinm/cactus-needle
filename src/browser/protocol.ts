import type { EngineConfig, Request, Response } from '../runtime/protocol.js';
import type { DownloadProgress } from './types.js';

export interface BrowserConfig extends EngineConfig {
  model: string | Uint8Array<ArrayBuffer>;
  wasmUrl: string;
  cache: boolean;
  offline: boolean;
  modelSha256?: string;
  modelSize?: number;
}

export type BrowserRequest = Request | { type: 'init'; config: BrowserConfig };
export type BrowserResponse = Response | { type: 'progress'; progress: DownloadProgress };
