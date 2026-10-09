import { errorMessage, NeedleError, validateInteger, validateText } from '../errors.js';
import type {
  AudioInput,
  SpeechSession,
  TranscribeOptions,
  TranscriptionChunk,
  TranscriptionResult,
  TranscriptionSettings,
} from '../speech.js';
import type { ToolCall, ToolCollection } from '../tools.js';
import type {
  CompletionOptions,
  CompletionResult,
  EmbedOptions,
  GenerateOptions,
  GenerateResult,
  NeedleSession,
} from '../types.js';
import { transcriptionSettings } from './audio.js';
import { serializeTools } from './configuration.js';
import type { Command, Request, Response, Result } from './protocol.js';

export interface Transport {
  send(request: Request): void;
  terminate(): Promise<void>;
  listen(onMessage: (message: Response) => void, onError: (error: Error) => void): void;
  ref?(): void;
  unref?(): void;
}

interface Pending {
  resolve(value: Result): void;
  reject(error: Error): void;
}

/** Owns ordering, errors and disposal; transports contain platform-specific worker operations. */
export class RpcSession<Tools extends ToolCollection>
  implements NeedleSession<Tools>, SpeechSession
{
  readonly ready: Promise<void>;
  readonly #pending = new Map<number, Pending>();
  #rejectReady!: (error: Error) => void;
  #nextId = 0;
  #closed = false;
  #closing: Promise<void> | undefined;

  constructor(
    readonly transport: Transport,
    readonly maxNewTokens: number,
  ) {
    this.ready = new Promise<void>((resolveReady, rejectReady) => {
      this.#rejectReady = rejectReady;
      transport.listen(
        (message) => {
          if (this.#closed) return;
          if (message.type === 'ready') resolveReady();
          else if (message.type === 'error' && message.id === undefined)
            this.#fail(new NeedleError(message.code, message.message));
          else if ('id' in message && message.id !== undefined) {
            const pending = this.#pending.get(message.id);
            this.#pending.delete(message.id);
            if (message.type === 'error')
              pending?.reject(new NeedleError(message.code, message.message));
            else if (message.type === 'result') pending?.resolve(message.value);
          }
          if (!this.#closed && this.#pending.size === 0) transport.unref?.();
        },
        (cause) => {
          if (!this.#closed)
            this.#fail(
              new NeedleError('WORKER_ERROR', `Inference worker failed: ${cause.message}`, {
                cause,
              }),
            );
        },
      );
    });
  }

  #fail(error: Error): Promise<void> {
    this.#closed = true;
    this.#rejectReady(error);
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    this.transport.ref?.();
    this.#closing ??= this.transport.terminate();
    return this.#closing;
  }

  async #request(command: Command, signal?: AbortSignal): Promise<Result> {
    signal?.throwIfAborted();
    if (this.#closed) throw new NeedleError('CLOSED', 'This model session is closed.');
    const abort = () => {
      void this.close();
    };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const result = await new Promise<Result>((resolveResult, reject) => {
        const id = this.#nextId++;
        this.#pending.set(id, { resolve: resolveResult, reject });
        this.transport.ref?.();
        try {
          this.transport.send({ ...command, id });
        } catch (cause) {
          this.#fail(new NeedleError('WORKER_ERROR', errorMessage(cause), { cause }));
        }
      });
      signal?.throwIfAborted();
      return result;
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }

  async generate<const RequestTools extends ToolCollection = Tools>({
    prompt,
    tools,
    maxOutputTokens,
    abortSignal,
  }: GenerateOptions<RequestTools>): Promise<GenerateResult<RequestTools>> {
    abortSignal?.throwIfAborted();
    const raw = await this.complete(prompt, {
      ...(tools === undefined ? {} : { tools }),
      ...(maxOutputTokens === undefined ? {} : { maxNewTokens: maxOutputTokens }),
      ...(abortSignal === undefined ? {} : { abortSignal }),
    });
    abortSignal?.throwIfAborted();
    if (!raw.success) throw new NeedleError('ENGINE_ERROR', raw.error ?? 'Generation failed.');
    const convert = (calls: CompletionResult['function_calls']) =>
      calls.map((call) => ({
        toolName: call.name,
        input: call.arguments,
      })) as ToolCall<RequestTools>[];
    return {
      toolCalls: convert(raw.function_calls),
      suppressedToolCalls: convert(raw.suppressed_calls),
      confidence: raw.confidence,
      reasoning: raw.reasoning,
      raw,
    };
  }

  async complete(input = '', options: CompletionOptions = {}): Promise<CompletionResult> {
    options.abortSignal?.throwIfAborted();
    validateText(input, 'input');
    const maxNewTokens = validateInteger(
      options.maxNewTokens ?? this.maxNewTokens,
      'maxNewTokens',
      1,
      65_536,
    );
    return (await this.#request(
      {
        method: 'complete',
        input,
        maxNewTokens,
        ...(options.tools === undefined ? {} : { toolsJson: serializeTools(options.tools) }),
      },
      options.abortSignal,
    )) as CompletionResult;
  }

  async embed(input = '', options: EmbedOptions = {}): Promise<Float32Array> {
    options.abortSignal?.throwIfAborted();
    validateText(input, 'input');
    return (await this.#request({ method: 'embed', input }, options.abortSignal)) as Float32Array;
  }

  async transcribe(
    audio: AudioInput,
    { abortSignal, ...options }: TranscribeOptions = {},
  ): Promise<TranscriptionResult> {
    abortSignal?.throwIfAborted();
    const settings = transcriptionSettings(options);
    return (await this.#request(
      { method: 'transcribe', audio, settings },
      abortSignal,
    )) as TranscriptionResult;
  }

  async embedAudio(audio: AudioInput): Promise<Float32Array> {
    return (await this.#request({ method: 'embedAudio', audio })) as Float32Array;
  }

  async streamTranscribe(
    audio: Float32Array | undefined,
    settings: TranscriptionSettings,
  ): Promise<TranscriptionChunk> {
    return (await this.#request({
      method: 'streamTranscribe',
      audio,
      settings,
    })) as TranscriptionChunk;
  }

  async reset(): Promise<void> {
    await this.#request({ method: 'reset' });
  }

  close(): Promise<void> {
    return (
      this.#closing ?? this.#fail(new NeedleError('CLOSED', 'This Needle instance was closed.'))
    );
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
}
