export type { NeedleErrorCode } from '../errors.js';
export { ExtractionValidationError, NeedleError } from '../errors.js';
export { DEFAULT_MODEL, DEFAULT_SPEECH_MODEL } from '../runtime/artifacts.js';
export type { JsonSchema, JsonValue, ToolDefinition, ToolSchema } from '../schema.js';
export type {
  AudioInput,
  AudioSource,
  PcmAudio,
  SpeechLanguage,
  StreamOptions,
  TranscribeOptions,
  TranscriptionChunk,
  TranscriptionResult,
  TranscriptionSettings,
  TranscriptWord,
} from '../speech.js';
export type { StandardJsonSchema, Tool, ToolCall, ToolCollection, ToolSet } from '../tools.js';
export { tool } from '../tools.js';
export type {
  CompletionOptions,
  CompletionResult,
  EmbedOptions,
  ExtractOptions,
  FunctionCall,
  GenerateOptions,
  GenerateResult,
  RunOptions,
  RunResult,
} from '../types.js';
export type { NeedleSettings, WhistleSettings } from './api.js';
export { close, extract, Needle, stream, transcribe, Whistle } from './api.js';
export { createNeedle, createWhistle } from './session.js';
export type { BrowserNeedleOptions, BrowserWhistleOptions, DownloadProgress } from './types.js';
