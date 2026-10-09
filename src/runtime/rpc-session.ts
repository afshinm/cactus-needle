import { errorMessage, NeedleError, validateInteger, validateText } from '../errors.js';
import type { ToolCall, ToolCollection } from '../tools.js';
import type {
  CompletionOptions,
  CompletionResult,
  GenerateOptions,
  GenerateResult,
  Needle,
} from '../types.js';
import type { Command, Request, Response } from './protocol.js';

export interface Transport {
  send(request: Request): void;
  terminate(): Promise<void>;
  listen(onMessage: (message: Response) => void, onError: (error: Error) => void): void;
  ref?(): void;
  unref?(): void;
}

interface Pending {
  resolve(value: CompletionResult | Float32Array | undefined): void;
  reject(error: Error): void;
}

/** Owns ordering, errors and disposal; transports contain platform-specific worker operations. */
export class RpcSession<Tools extends ToolCollection> implements Needle<Tools> {
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

  #request(command: Command): Promise<CompletionResult | Float32Array | undefined> {
    if (this.#closed)
      return Promise.reject(new NeedleError('CLOSED', 'This Needle instance is closed.'));
    return new Promise((resolveResult, reject) => {
      const id = this.#nextId++;
      this.#pending.set(id, { resolve: resolveResult, reject });
      this.transport.ref?.();
      try {
        this.transport.send({ ...command, id });
      } catch (cause) {
        this.#fail(new NeedleError('WORKER_ERROR', errorMessage(cause), { cause }));
      }
    });
  }

  async generate({
    prompt,
    maxOutputTokens,
    abortSignal,
  }: GenerateOptions): Promise<GenerateResult<Tools>> {
    abortSignal?.throwIfAborted();
    const abort = () => {
      void this.close();
    };
    abortSignal?.addEventListener('abort', abort, { once: true });
    try {
      const raw = await this.complete(
        prompt,
        maxOutputTokens === undefined ? {} : { maxNewTokens: maxOutputTokens },
      );
      abortSignal?.throwIfAborted();
      if (!raw.success) throw new NeedleError('ENGINE_ERROR', raw.error ?? 'Generation failed.');
      const convert = (calls: CompletionResult['function_calls']) =>
        calls.map((call) => ({ toolName: call.name, input: call.arguments })) as ToolCall<Tools>[];
      return {
        toolCalls: convert(raw.function_calls),
        suppressedToolCalls: convert(raw.suppressed_calls),
        confidence: raw.confidence,
        reasoning: raw.reasoning,
        raw,
      };
    } catch (error) {
      if (abortSignal?.aborted) throw abortSignal.reason;
      throw error;
    } finally {
      abortSignal?.removeEventListener('abort', abort);
    }
  }

  async complete(input: string, options: CompletionOptions = {}): Promise<CompletionResult> {
    validateText(input, 'input');
    const maxNewTokens = validateInteger(
      options.maxNewTokens ?? this.maxNewTokens,
      'maxNewTokens',
      1,
      65_536,
    );
    return (await this.#request({ method: 'complete', input, maxNewTokens })) as CompletionResult;
  }

  async embed(input: string): Promise<Float32Array> {
    validateText(input, 'input');
    return (await this.#request({ method: 'embed', input })) as Float32Array;
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
