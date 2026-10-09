import type { ToolCollection } from '../tools.js';
import type { SessionOptions } from '../types.js';

export interface NeedleOptions<Tools extends ToolCollection = ToolCollection>
  extends SessionOptions<Tools> {
  /** Local .cact file, or a file: URL. Defaults to the pinned model's cache path. Never downloads. */
  modelPath?: string | URL;
  /** Root of the model cache; used only when modelPath is omitted. */
  cacheDir?: string;
  /** Cancel loading and terminate the worker during setup. */
  abortSignal?: AbortSignal;
}

export interface DownloadOptions {
  /** Defaults to needle3. Whistle is a separate, optional download. */
  model?: 'needle3' | 'whistle';
  cacheDir?: string;
  signal?: AbortSignal;
  /** Network timeout in milliseconds. Defaults to 300000. */
  timeoutMs?: number;
  onProgress?: (progress: { receivedBytes: number; totalBytes: number }) => void;
}

export type WhistleOptions = Pick<
  NeedleOptions,
  'modelPath' | 'cacheDir' | 'bufferSize' | 'abortSignal'
>;
