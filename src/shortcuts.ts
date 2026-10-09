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

/** Python-style helpers retain the default models; custom settings use a scoped session. */
export function shortcuts<TextOptions extends SessionOptions, SpeechOptions extends object>(
  textModel: (options?: TextOptions) => Needle,
  speechModel: (options?: SpeechOptions) => Whistle,
) {
  let text: Needle | undefined;
  let speech: Whistle | undefined;
  const closed = (error: unknown, signal?: AbortSignal) =>
    signal?.aborted ||
    (error instanceof NeedleError && ['CLOSED', 'WORKER_ERROR'].includes(error.code));
  return {
    async *stream(
      chunks: AsyncIterable<Float32Array> | Iterable<Float32Array>,
      options: StreamOptions & SpeechOptions = {} as StreamOptions & SpeechOptions,
    ): AsyncIterableIterator<TranscriptionChunk> {
      const { language, keywords, abortSignal, ...loading } = options;
      abortSignal?.throwIfAborted();
      const custom = Object.keys(loading).length > 0;
      if (!custom) speech ??= speechModel();
      const model = custom ? speechModel(loading as SpeechOptions) : (speech as Whistle);
      try {
        yield* model.stream(chunks, {
          ...(language === undefined ? {} : { language }),
          ...(keywords === undefined ? {} : { keywords }),
          ...(abortSignal === undefined ? {} : { abortSignal }),
        });
      } catch (error) {
        if (!custom && closed(error, abortSignal) && speech === model) {
          speech = undefined;
          await model.close();
        }
        throw error;
      } finally {
        if (custom) await model.close();
      }
    },
    async transcribe(
      audio: AudioSource,
      options: TranscribeOptions & SpeechOptions = {} as TranscribeOptions & SpeechOptions,
    ) {
      const { language, keywords, wordTimestamps, abortSignal, ...loading } = options;
      abortSignal?.throwIfAborted();
      const custom = Object.keys(loading).length > 0;
      if (!custom) speech ??= speechModel();
      const model = custom ? speechModel(loading as SpeechOptions) : (speech as Whistle);
      try {
        return await model.transcribe(audio, {
          ...(language === undefined ? {} : { language }),
          ...(keywords === undefined ? {} : { keywords }),
          ...(wordTimestamps === undefined ? {} : { wordTimestamps }),
          ...(abortSignal === undefined ? {} : { abortSignal }),
        });
      } catch (error) {
        if (!custom && closed(error, abortSignal) && speech === model) {
          speech = undefined;
          await model.close();
        }
        throw error;
      } finally {
        if (custom) await model.close();
      }
    },

    async extract<const Schema extends JsonSchema | StandardJsonSchema>(
      input: string,
      schema: Schema,
      options: ExtractOptions & TextOptions = {} as ExtractOptions & TextOptions,
    ): Promise<InferSchema<Schema> | null> {
      const { strict, maxNewTokens, abortSignal, ...loading } = options;
      abortSignal?.throwIfAborted();
      const custom = Object.keys(loading).length > 0;
      if (!custom) text ??= textModel();
      const model = custom ? textModel(loading as TextOptions) : (text as Needle);
      try {
        return await model.extract(input, schema, {
          ...(strict === undefined ? {} : { strict }),
          ...(maxNewTokens === undefined ? {} : { maxNewTokens }),
          ...(abortSignal === undefined ? {} : { abortSignal }),
        });
      } catch (error) {
        if (!custom && closed(error, abortSignal) && text === model) {
          text = undefined;
          await model.close();
        }
        throw error;
      } finally {
        if (custom) await model.close();
      }
    },

    async close(): Promise<void> {
      const models = [text, speech];
      text = undefined;
      speech = undefined;
      await Promise.all(models.map((model) => model?.close()));
    },
  };
}
