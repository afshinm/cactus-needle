import { errorMessage, NeedleError, validateInteger, validateText } from './errors.js';
import { configuration } from './runtime/configuration.js';
import type { JsonSchema, JsonValue } from './schema.js';
import {
  type InferSchema,
  type StandardJsonSchema,
  type ToolCollection,
  type ToolSet,
  tool,
  validateToolInput,
} from './tools.js';
import type {
  CompletionOptions,
  CompletionResult,
  ExtractOptions,
  GenerateOptions,
  GenerateResult,
  Needle,
  NeedleSession,
  RunOptions,
  RunResult,
  SessionOptions,
} from './types.js';

/** Owns lazy loading and serializes whole operations, including multi-step tool runs. */
export class Resident<Session extends { close(): Promise<void> }> {
  readonly #lifetime = new AbortController();
  #session: Promise<Session> | undefined;
  #tail: Promise<unknown> = Promise.resolve();
  #closing: Promise<void> | undefined;

  constructor(private readonly load: (signal: AbortSignal) => Promise<Session>) {}

  use<T>(
    run: (session: Session, signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.#lifetime.signal.aborted) return Promise.reject(this.#lifetime.signal.reason);
    const cancel = () => {
      void this.close();
    };
    signal?.addEventListener('abort', cancel, { once: true });
    const stopped = this.#lifetime.signal;
    let rejectClosed!: (reason: unknown) => void;
    const closed = new Promise<never>((_resolve, reject) => {
      rejectClosed = reject;
    });
    const onClose = () => rejectClosed(signal?.aborted ? signal.reason : stopped.reason);
    stopped.addEventListener('abort', onClose, { once: true });
    const operation = this.#tail.then(async () => {
      stopped.throwIfAborted();
      if (!this.#session) {
        this.#session = this.load(stopped).catch((error) => {
          this.#session = undefined;
          throw error;
        });
      }
      const session = await this.#session;
      stopped.throwIfAborted();
      const result = await run(session, stopped);
      stopped.throwIfAborted();
      return result;
    });
    this.#tail = operation.catch(() => {});
    return Promise.race([operation, closed]).finally(() => {
      signal?.removeEventListener('abort', cancel);
      stopped.removeEventListener('abort', onClose);
    });
  }

  ready(signal?: AbortSignal): Promise<void> {
    return this.use(async () => {}, signal);
  }

  close(): Promise<void> {
    if (!this.#closing) {
      this.#lifetime.abort(new NeedleError('CLOSED', 'This model session was closed.'));
      this.#closing =
        this.#session?.then(
          (session) => session.close(),
          () => {},
        ) ?? Promise.resolve();
    }
    return this.#closing;
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
}

export class ExtractionValidationError extends NeedleError {
  override readonly name = 'ExtractionValidationError';
  constructor(message = 'The model returned values that are not grounded in the input.') {
    super('INVALID_RESPONSE', message);
  }
}

function strictOption(strict: boolean | undefined): boolean {
  if (strict !== undefined && typeof strict !== 'boolean')
    throw new NeedleError('INVALID_ARGUMENT', 'strict must be a boolean.');
  return strict ?? true;
}

function checkSuccess(result: CompletionResult): void {
  if (!result.success) throw new NeedleError('ENGINE_ERROR', result.error ?? 'Generation failed.');
}

export class Agent<Tools extends ToolCollection = ToolCollection>
  extends Resident<NeedleSession<Tools>>
  implements Needle<Tools>
{
  constructor(
    load: (signal: AbortSignal) => Promise<NeedleSession<Tools>>,
    private readonly options: SessionOptions<Tools>,
  ) {
    super(load);
    configuration(options);
  }

  generate<const RequestTools extends ToolCollection = Tools>(
    options: GenerateOptions<RequestTools>,
  ): Promise<GenerateResult<RequestTools>> {
    return this.use(async (session) => {
      if (this.options.stateless) await session.reset();
      return session.generate(options);
    }, options.abortSignal);
  }

  complete(input = '', options?: CompletionOptions): Promise<CompletionResult> {
    return this.use(async (session) => {
      if (this.options.stateless) await session.reset();
      return session.complete(input, options);
    });
  }

  embed(input: string): Promise<Float32Array> {
    return this.use((session) => session.embed(input));
  }

  reset(): Promise<void> {
    return this.use((session) => session.reset());
  }

  async run(query = '', options: RunOptions = {}): Promise<RunResult> {
    validateText(query, 'query');
    const maxSteps = validateInteger(options.maxSteps ?? 8, 'maxSteps', 1, 32);
    const strict = strictOption(options.strict);
    const completion =
      options.maxNewTokens === undefined ? {} : { maxNewTokens: options.maxNewTokens };
    return this.use(async (session, signal) => {
      if (this.options.stateless) await session.reset();
      let response = await session.complete(query, completion);
      const executed: JsonValue[] = [];
      for (let step = 0; step < maxSteps; step++) {
        checkSuccess(response);
        if (response.type !== 'call' || !response.function_calls.length) break;
        const results: JsonValue[] = [];
        for (const call of response.function_calls) {
          signal.throwIfAborted();
          const ungrounded = response.validation?.ungrounded?.some(
            (path) => path === call.name || path.startsWith(`${call.name}.`),
          );
          if (strict && (ungrounded || response.validation?.negation)) {
            results.push({ error: 'The model flagged this call as ungrounded.' });
            continue;
          }
          const tools = this.options.tools;
          const definition =
            tools && !Array.isArray(tools) && Object.hasOwn(tools, call.name)
              ? (tools as ToolSet)[call.name]
              : undefined;
          if (!definition?.execute) {
            results.push({ error: `No execute function registered for ${call.name}.` });
            continue;
          }
          try {
            await validateToolInput(definition, call.arguments);
            signal.throwIfAborted();
            const value = await definition.execute(call.arguments, { abortSignal: signal });
            // Tool results cross the same JSON boundary as Python's run loop.
            results.push(
              JSON.parse(
                JSON.stringify(value ?? null, (_key, item: unknown) =>
                  typeof item === 'bigint' ? String(item) : item,
                ),
              ) as JsonValue,
            );
          } catch (error) {
            signal.throwIfAborted();
            results.push({ error: errorMessage(error) });
          }
        }
        executed.push(...results);
        signal.throwIfAborted();
        response = await session.complete(JSON.stringify(results), completion);
      }
      checkSuccess(response);
      return { ...response, results: executed };
    }, options.abortSignal);
  }

  async extract<const Schema extends JsonSchema | StandardJsonSchema>(
    text: string,
    schema: Schema,
    options: ExtractOptions = {},
  ): Promise<InferSchema<Schema> | null> {
    validateText(text, 'text');
    const strict = strictOption(options.strict);
    const definition = tool({ inputSchema: schema as JsonSchema });
    return this.use(async (session) => {
      await session.reset();
      const result = await session.complete(text, {
        tools: { extract: definition },
        ...(options.maxNewTokens === undefined ? {} : { maxNewTokens: options.maxNewTokens }),
      });
      checkSuccess(result);
      if (strict && (result.validation?.ungrounded?.length || result.validation?.negation))
        throw new ExtractionValidationError();
      const call = result.function_calls.find((call) => call.name === 'extract');
      if (!call) return null;
      await validateToolInput(definition, call.arguments);
      return call.arguments as InferSchema<Schema>;
    }, options.abortSignal);
  }
}
