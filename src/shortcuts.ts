import { NeedleError } from './errors.js';
import type { JsonSchema } from './schema.js';
import type {
  AudioSource,
  StreamOptions,
  TranscribeOptions,
  TranscriptionChunk,
  Whistle,
} from './speech.js';
import type { InferSchema, StandardJsonSchema } from './tools.js';
import type { ExtractOptions, Needle, SessionOptions } from './types.js';

/** Keeps one default model and scopes models with custom loading settings to a single operation. */
class DefaultModel<Options extends object, Model extends { close(): Promise<void> }> {
  #model: Model | undefined;

  constructor(private readonly create: (options?: Options) => Model) {}

  #acquire(options: Options, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const custom = Object.values(options).some((value) => value !== undefined);
    const model = custom ? this.create(options) : (this.#model ?? this.create());
    if (!custom) this.#model = model;
    return {
      model,
      release: async (error: unknown) => {
        const closed =
          signal?.aborted ||
          (error instanceof NeedleError &&
            (error.code === 'CLOSED' || error.code === 'WORKER_ERROR'));
        if (custom) await model.close();
        else if (closed && this.#model === model) {
          this.#model = undefined;
          await model.close();
        }
      },
    };
  }

  async use<T>(
    options: Options,
    signal: AbortSignal | undefined,
    run: (model: Model) => Promise<T>,
  ): Promise<T> {
    const { model, release } = this.#acquire(options, signal);
    let failure: unknown;
    try {
      return await run(model);
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      await release(failure);
    }
  }

  async *stream<T>(
    options: Options,
    signal: AbortSignal | undefined,
    run: (model: Model) => AsyncIterable<T>,
  ): AsyncIterableIterator<T> {
    const { model, release } = this.#acquire(options, signal);
    let failure: unknown;
    try {
      yield* run(model);
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      await release(failure);
    }
  }

  async close(): Promise<void> {
    const model = this.#model;
    this.#model = undefined;
    await model?.close();
  }
}

/** Python-style helpers retain the default models; custom settings use a scoped session. */
export function shortcuts<TextOptions extends SessionOptions, SpeechOptions extends object>(
  textModel: (options?: TextOptions) => Needle,
  speechModel: (options?: SpeechOptions) => Whistle,
) {
  const text = new DefaultModel(textModel);
  const speech = new DefaultModel(speechModel);
  return {
    stream(
      chunks: AsyncIterable<Float32Array> | Iterable<Float32Array>,
      options?: StreamOptions & SpeechOptions,
    ): AsyncIterableIterator<TranscriptionChunk> {
      const { language, keywords, abortSignal, ...loading } = options ?? {};
      return speech.stream(loading as SpeechOptions, abortSignal, (model) =>
        model.stream(chunks, {
          ...(language === undefined ? {} : { language }),
          ...(keywords === undefined ? {} : { keywords }),
          ...(abortSignal === undefined ? {} : { abortSignal }),
        }),
      );
    },
    async transcribe(audio: AudioSource, options?: TranscribeOptions & SpeechOptions) {
      const { language, keywords, wordTimestamps, abortSignal, ...loading } = options ?? {};
      return speech.use(loading as SpeechOptions, abortSignal, (model) =>
        model.transcribe(audio, {
          ...(language === undefined ? {} : { language }),
          ...(keywords === undefined ? {} : { keywords }),
          ...(wordTimestamps === undefined ? {} : { wordTimestamps }),
          ...(abortSignal === undefined ? {} : { abortSignal }),
        }),
      );
    },

    async extract<const Schema extends JsonSchema | StandardJsonSchema>(
      input: string,
      schema: Schema,
      options?: ExtractOptions & TextOptions,
    ): Promise<InferSchema<Schema> | null> {
      const { strict, maxNewTokens, abortSignal, ...loading } = options ?? {};
      return text.use(loading as TextOptions, abortSignal, (model) =>
        model.extract(input, schema, {
          ...(strict === undefined ? {} : { strict }),
          ...(maxNewTokens === undefined ? {} : { maxNewTokens }),
          ...(abortSignal === undefined ? {} : { abortSignal }),
        }),
      );
    },

    async close(): Promise<void> {
      await Promise.all([text.close(), speech.close()]);
    },
  };
}
