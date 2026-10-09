export type { NeedleErrorCode } from './errors.js';
export { ExtractionValidationError, NeedleError } from './errors.js';
export type { NeedleSettings, WhistleSettings } from './node/api.js';
export { close, extract, Needle, stream, transcribe, Whistle } from './node/api.js';
export { DEFAULT_MODEL, downloadModel, getModelPath } from './node/model.js';
export { createNeedle, createWhistle } from './node/session.js';
export type { DownloadOptions, NeedleOptions, WhistleOptions } from './node/types.js';
export { DEFAULT_SPEECH_MODEL } from './runtime/artifacts.js';
export type { JsonSchema, JsonValue, ToolDefinition, ToolSchema } from './schema.js';
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
} from './speech.js';
export type { StandardJsonSchema, Tool, ToolCall, ToolCollection, ToolSet } from './tools.js';
export { tool } from './tools.js';
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
} from './types.js';
