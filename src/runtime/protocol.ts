import type { NeedleErrorCode } from '../errors.js';
import type { CompletionResult } from '../types.js';

export interface EngineConfig {
  system: string;
  toolsJson: string;
  stateless: boolean;
  bufferSize: number;
}

export type Command =
  | { method: 'complete'; input: string; maxNewTokens: number; toolsJson?: string }
  | { method: 'embed'; input: string }
  | { method: 'reset' };

export type Request = Command & { id: number };
export type Response =
  | { type: 'ready' }
  | { type: 'result'; id: number; value: CompletionResult | Float32Array | undefined }
  | { type: 'error'; id?: number; code: NeedleErrorCode; message: string };
