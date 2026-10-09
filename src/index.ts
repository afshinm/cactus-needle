export type { NeedleErrorCode } from './errors.js';
export { NeedleError } from './errors.js';
export { DEFAULT_MODEL, downloadModel, getModelPath } from './node/model.js';
export { createNeedle } from './node/session.js';
export type { DownloadOptions, NeedleOptions } from './node/types.js';
export type { JsonSchema, JsonValue, ToolDefinition, ToolSchema } from './schema.js';
export type { StandardJsonSchema, Tool, ToolCall, ToolCollection, ToolSet } from './tools.js';
export { tool } from './tools.js';
export type {
  CompletionOptions,
  CompletionResult,
  FunctionCall,
  GenerateOptions,
  GenerateResult,
  Needle,
} from './types.js';
