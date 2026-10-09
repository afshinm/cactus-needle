/// <reference lib="esnext.disposable" preserve="true" />

import type { JsonValue } from './schema.js';
import type { ToolCall, ToolCollection } from './tools.js';

export interface FunctionCall {
  name: string;
  arguments: Record<string, JsonValue>;
}

export interface CompletionResult {
  type: 'call' | 'respond' | 'refuse' | 'text';
  success: boolean;
  error: string | null;
  error_code: string | number | null;
  function_calls: FunctionCall[];
  suppressed_calls: FunctionCall[];
  reasoning: string;
  /** Null when custom weights have no trained confidence head. */
  confidence: number | null;
  prefill_tps?: number;
  decode_tps?: number;
  /** Unavailable measurements, including the WASM engine's negative sentinel, become null. */
  peak_ram_mb?: number | null;
  validation?: {
    ungrounded?: string[];
    negation?: boolean;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface SessionOptions<Tools extends ToolCollection = ToolCollection> {
  tools?: Tools;
  /** Environment facts, e.g. "date: 2026-10-09; locale: en-IE". No date is added implicitly. */
  system?: string;
  /** Clear conversation history before each completion. Defaults to false. */
  stateless?: boolean;
  /** Default generation token limit, 512. */
  maxOutputTokens?: number;
  /** Compatibility alias for maxOutputTokens. */
  maxNewTokens?: number;
  /** Output JSON buffer in bytes. Defaults to 262144; increase for large responses. */
  bufferSize?: number;
}

export interface CompletionOptions {
  maxNewTokens?: number;
  /** Replace the session's default tools for this request. Changing tools clears history. */
  tools?: ToolCollection;
}

export interface GenerateOptions<Tools extends ToolCollection = ToolCollection> {
  prompt: string;
  /** Replace the session's default tools for this request without reloading the model. */
  tools?: Tools;
  maxOutputTokens?: number;
  /** Aborting active inference closes the session and cancels its queued operations. */
  abortSignal?: AbortSignal;
}

export interface GenerateResult<Tools extends ToolCollection = ToolCollection> {
  toolCalls: ToolCall<Tools>[];
  suppressedToolCalls: ToolCall<Tools>[];
  confidence: number | null;
  reasoning: string;
  /** Parsed engine envelope, including grounding validation and timing. */
  raw: CompletionResult;
}

export interface Needle<Tools extends ToolCollection = ToolCollection> {
  generate<const RequestTools extends ToolCollection = Tools>(
    options: GenerateOptions<RequestTools>,
  ): Promise<GenerateResult<RequestTools>>;
  /** Infer tool calls locally. This method never executes the tools. Calls are serialized per instance. */
  complete(input: string, options?: CompletionOptions): Promise<CompletionResult>;
  embed(input: string): Promise<Float32Array>;
  /** Clear conversation history while retaining the model and tools. */
  reset(): Promise<void>;
  /** Stop the worker and reject outstanding calls. Safe to call more than once. */
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}
