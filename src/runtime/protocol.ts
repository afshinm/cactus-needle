import type { NeedleErrorCode } from '../errors.js';
import type {
  AudioInput,
  TranscriptionChunk,
  TranscriptionResult,
  TranscriptionSettings,
} from '../speech.js';
import type { CompletionResult } from '../types.js';

export interface EngineConfig {
  modelKind?: 'needle3' | 'whistle';
  system: string;
  toolsJson: string;
  stateless: boolean;
  bufferSize: number;
}

export type Command =
  | { method: 'streamTranscribe'; audio: Float32Array | undefined; settings: TranscriptionSettings }
  | { method: 'embedAudio'; audio: AudioInput }
  | { method: 'transcribe'; audio: AudioInput; settings: TranscriptionSettings }
  | { method: 'complete'; input: string; maxNewTokens: number; toolsJson?: string }
  | { method: 'embed'; input: string }
  | { method: 'reset' };

export type Request = Command & { id: number };
export type Result =
  | CompletionResult
  | TranscriptionResult
  | TranscriptionChunk
  | Float32Array
  | undefined;
export type Response =
  | { type: 'ready' }
  | { type: 'result'; id: number; value: Result }
  | { type: 'error'; id?: number; code: NeedleErrorCode; message: string };
