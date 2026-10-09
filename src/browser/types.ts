import type { ToolCollection } from '../tools.js';
import type { SessionOptions } from '../types.js';

export interface DownloadProgress {
  loaded: number;
  total?: number;
  percentage?: number;
}

export interface BrowserNeedleOptions<Tools extends ToolCollection = ToolCollection>
  extends SessionOptions<Tools> {
  /** Defaults to the pinned 35.3 MB model. URLs may be relative to the page. */
  model?: string | URL | ArrayBuffer | Uint8Array;
  /** Persist verified model and WASM bytes with CacheStorage, when available. Default true. */
  cache?: boolean;
  /** Load model and WASM from CacheStorage only. Worker/application assets must also be available. */
  offline?: boolean;
  /** Optional SHA-256 for a custom model. The default model is always verified. */
  modelSha256?: string;
  /** Progress for model loading, including a completed event for cache hits. */
  onDownloadProgress?: (progress: DownloadProgress) => void;
  /** Cancels setup, including any downloads and worker initialization. */
  abortSignal?: AbortSignal;
  /** Override the packaged assets when using a bundler or hosting them separately. */
  workerUrl?: string | URL;
  wasmUrl?: string | URL;
}

/** Same asset controls as Needle, defaulting to the pinned 16.9 MB Whistle model. */
export type BrowserWhistleOptions = Omit<
  BrowserNeedleOptions,
  'tools' | 'system' | 'stateless' | 'maxOutputTokens' | 'maxNewTokens'
>;
