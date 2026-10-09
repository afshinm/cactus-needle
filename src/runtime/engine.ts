import { NeedleError } from '../errors.js';
import type {
  AudioInput,
  SpeechLanguage,
  TranscriptionChunk,
  TranscriptionResult,
  TranscriptionSettings,
  TranscriptWord,
} from '../speech.js';
import type { CompletionResult, FunctionCall } from '../types.js';
import { prepareAudio, SPEECH_LANGUAGES } from './audio.js';
import type { EngineConfig } from './protocol.js';

export interface WasmModule {
  HEAPU8: Uint8Array;
  _malloc(bytes: number): number;
  _free(pointer: number): void;
  _needle_load(pointer: number, bytes: bigint): number;
  _needle_models(): number;
  _needle_stream_transcribe_process(
    pcm: number,
    samples: number,
    language: number,
    keywords: number,
    out: number,
    capacity: number,
  ): number;
  _needle_stream_transcribe_stop(out: number, capacity: number): number;
  _needle_transcribe(
    pcm: number,
    samples: number,
    language: number,
    keywords: number,
    wordTimestamps: number,
    out: number,
    capacity: number,
  ): number;
  _needle_init(system: number, tools: number, index: number): number;
  _needle_last_error(): number;
  _needle_complete(
    input: number,
    pcm: number,
    samples: number,
    tokens: number,
    out: number,
    capacity: number,
  ): number;
  _needle_embed(input: number, pcm: number, samples: number, out: number, capacity: number): number;
  _needle_reset(): void;
  UTF8ToString(pointer: number): string;
}

export type Factory = (options: { wasmBinary: Uint8Array }) => Promise<WasmModule>;

/** Validate the documented Needle 3 container before handing it to native WASM code. */
export function inspectModel(data: Uint8Array): { calibrated: boolean } {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const invalid = (detail: string): never => {
    throw new NeedleError('INVALID_MODEL', `Invalid Needle 3 .cact model: ${detail}`);
  };
  if (data.length < 196 || view.getUint32(0, true) !== 0x05e12a84)
    invalid('wrong format tag or truncated header.');
  const count = view.getUint32(4, true);
  const directory = 196 + view.getUint32(8, true) * 4;
  if (!count || directory + count * 44 > data.length) invalid('truncated tensor directory.');
  for (let index = 0; index < count; index++) {
    const record = directory + index * 44;
    const offset = view.getBigUint64(record + 20, true);
    const length = view.getBigUint64(record + 28, true);
    if (offset + length > BigInt(data.length)) invalid(`tensor ${index} extends beyond the file.`);
  }
  // The final RAW tensor is the tokenizer. A manifest before the optional heads
  // lists FP16 head codes: embedding=1, confidence=2, router=3. Match upstream's
  // confidence detection; custom LoRA exports omit the trained confidence head.
  if (data[directory + (count - 1) * 44] !== 4) return { calibrated: false };
  for (let heads = 1; heads <= 3; heads++) {
    const index = count - 2 - 6 * heads;
    if (index < 0) continue;
    const record = directory + index * 44;
    if (data[record] !== 1 || data[record + 1] !== 1 || view.getUint32(record + 4, true) !== heads)
      continue;
    const offset = Number(view.getBigUint64(record + 20, true));
    const size = view.getBigUint64(record + 28, true);
    if (size < BigInt(heads * 2)) invalid('truncated head manifest.');
    for (let head = 0; head < heads; head++) {
      if (view.getUint16(offset + head * 2, true) === 0x4000) return { calibrated: true };
    }
    return { calibrated: false };
  }
  return { calibrated: false };
}

function isCall(value: unknown): value is FunctionCall {
  if (!value || typeof value !== 'object') return false;
  const call = value as Partial<FunctionCall>;
  return (
    typeof call.name === 'string' &&
    call.arguments !== null &&
    typeof call.arguments === 'object' &&
    !Array.isArray(call.arguments)
  );
}

function nonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function validWords(words: unknown): words is TranscriptWord[] {
  return (
    Array.isArray(words) &&
    words.every(
      (word) =>
        word &&
        typeof word.word === 'string' &&
        nonnegative(word.start) &&
        nonnegative(word.end) &&
        word.end >= word.start &&
        nonnegative(word.probability) &&
        word.probability <= 1,
    )
  );
}

export class Engine {
  readonly #output: number;
  #toolsJson: string | undefined;

  private constructor(
    readonly module: WasmModule,
    readonly config: EngineConfig,
    readonly calibrated: boolean,
  ) {
    this.#output = this.#allocate(config.bufferSize);
  }

  static create(module: WasmModule, config: EngineConfig, data: Uint8Array): Engine {
    const { calibrated } = inspectModel(data);
    const engine = new Engine(module, config, calibrated);
    const model = engine.#allocate(data.length);
    module.HEAPU8.set(data, model);
    // Keep the archive allocation for the full worker lifetime: engines may read
    // tensor/tokenizer data in place. Terminating the worker reclaims all memory.
    if (module._needle_load(model, BigInt(data.length)) < 0) throw engine.#error('needle_load');
    const speech = config.modelKind === 'whistle';
    if (!(module._needle_models() & (speech ? 2 : 1)))
      throw new NeedleError(
        'INVALID_MODEL',
        `Expected ${speech ? 'Whistle speech' : 'Needle text'} weights.`,
      );
    if (!speech) engine.#configureTools(config.toolsJson);
    return engine;
  }

  #configureTools(toolsJson: string): void {
    if (toolsJson === this.#toolsJson) return;
    // Rebind the conversation prefix, retaining weights and WASM memory. If init
    // fails, the next request must initialize again even with the previous tools.
    this.#toolsJson = undefined;
    this.#withString(this.config.system, (system) =>
      this.#withString(toolsJson, (tools) => {
        if (this.module._needle_init(system, tools, 0) < 0) throw this.#error('needle_init');
      }),
    );
    this.#toolsJson = toolsJson;
  }

  #allocate(size: number): number {
    const pointer = this.module._malloc(size);
    if (!pointer)
      throw new NeedleError('ENGINE_ERROR', `Unable to allocate ${size} bytes of WASM memory.`);
    return pointer;
  }

  #withString<T>(value: string, run: (pointer: number) => T): T {
    const bytes = new TextEncoder().encode(value);
    const pointer = this.#allocate(bytes.length + 1);
    try {
      this.module.HEAPU8.set(bytes, pointer);
      this.module.HEAPU8[pointer + bytes.length] = 0;
      return run(pointer);
    } finally {
      this.module._free(pointer);
    }
  }

  #error(operation: string): NeedleError {
    const pointer = this.module._needle_last_error();
    const detail = pointer ? this.module.UTF8ToString(pointer) : '';
    return new NeedleError('ENGINE_ERROR', `${operation} failed${detail ? `: ${detail}` : '.'}`);
  }

  #readJson(): unknown {
    const view = this.module.HEAPU8.subarray(this.#output, this.#output + this.config.bufferSize);
    const end = view.indexOf(0);
    if (end < 0)
      throw new NeedleError('INVALID_RESPONSE', 'Output was truncated. Increase bufferSize.');
    try {
      return JSON.parse(new TextDecoder().decode(view.subarray(0, end)));
    } catch (cause) {
      throw new NeedleError(
        'INVALID_RESPONSE',
        'Engine returned invalid JSON. Increase bufferSize.',
        { cause },
      );
    }
  }

  complete(
    input: string,
    maxNewTokens: number,
    toolsJson = this.config.toolsJson,
  ): CompletionResult {
    this.#configureTools(toolsJson);
    if (this.config.stateless) this.reset();
    return this.#withString(input, (pointer) => {
      this.module.HEAPU8[this.#output] = 0;
      const code = this.module._needle_complete(
        pointer,
        0,
        0,
        maxNewTokens,
        this.#output,
        this.config.bufferSize,
      );
      if (code < 0) throw this.#error('needle_complete');
      const result = this.#readJson() as CompletionResult;
      if (
        !result ||
        typeof result !== 'object' ||
        typeof result.success !== 'boolean' ||
        !['call', 'respond', 'refuse', 'text'].includes(result.type) ||
        !Array.isArray(result.function_calls) ||
        !result.function_calls.every(isCall) ||
        (result.suppressed_calls !== undefined &&
          (!Array.isArray(result.suppressed_calls) || !result.suppressed_calls.every(isCall)))
      ) {
        throw new NeedleError(
          'INVALID_RESPONSE',
          'Engine returned an unexpected completion envelope.',
        );
      }
      result.suppressed_calls ??= [];
      if (
        !this.calibrated ||
        typeof result.confidence !== 'number' ||
        !Number.isFinite(result.confidence)
      )
        result.confidence = null;
      if (
        result.peak_ram_mb !== undefined &&
        (typeof result.peak_ram_mb !== 'number' ||
          !Number.isFinite(result.peak_ram_mb) ||
          result.peak_ram_mb < 0)
      ) {
        result.peak_ram_mb = null;
      }
      return result;
    });
  }

  transcribe(audio: AudioInput, settings: TranscriptionSettings): TranscriptionResult {
    const { samples, durationInSeconds } = prepareAudio(audio);
    const pcm = this.#allocate(samples.byteLength);
    try {
      this.module.HEAPU8.set(
        new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength),
        pcm,
      );
      return this.#withString(settings.language ?? '', (language) =>
        this.#withString(settings.keywords?.join('\n') ?? '', (keywords) => {
          this.module.HEAPU8[this.#output] = 0;
          const code = this.module._needle_transcribe(
            pcm,
            samples.length,
            settings.language ? language : 0,
            settings.keywords?.length ? keywords : 0,
            settings.wordTimestamps ? 1 : 0,
            this.#output,
            this.config.bufferSize,
          );
          if (code < 0) throw this.#error('needle_transcribe');
          const raw = this.#readJson() as {
            text: string;
            language: SpeechLanguage | '';
            ttft_ms: number;
            decode_tps: number;
            words?: TranscriptWord[];
          };
          if (
            !raw ||
            typeof raw !== 'object' ||
            typeof raw.text !== 'string' ||
            (raw.language !== '' && !SPEECH_LANGUAGES.includes(raw.language)) ||
            !nonnegative(raw.ttft_ms) ||
            !nonnegative(raw.decode_tps) ||
            (raw.words !== undefined && !validWords(raw.words))
          )
            throw new NeedleError(
              'INVALID_RESPONSE',
              'Engine returned an unexpected transcription envelope.',
            );
          return {
            text: raw.text,
            language: raw.language,
            durationInSeconds,
            timeToFirstTokenMs: raw.ttft_ms,
            tokensPerSecond: raw.decode_tps,
            ...(raw.words === undefined ? {} : { words: raw.words }),
          };
        }),
      );
    } finally {
      this.module._free(pcm);
    }
  }

  streamTranscribe(
    audio: Float32Array | undefined,
    settings: TranscriptionSettings,
  ): TranscriptionChunk {
    this.module.HEAPU8[this.#output] = 0;
    let code: number;
    if (audio === undefined) {
      code = this.module._needle_stream_transcribe_stop(this.#output, this.config.bufferSize);
    } else {
      if (!(audio instanceof Float32Array))
        throw new NeedleError(
          'INVALID_ARGUMENT',
          'Stream chunks must be 16 kHz mono Float32Array samples.',
        );
      const { samples } = prepareAudio(audio);
      const pcm = this.#allocate(samples.byteLength);
      try {
        this.module.HEAPU8.set(
          new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength),
          pcm,
        );
        code = this.#withString(settings.language ?? '', (language) =>
          this.#withString(settings.keywords?.join('\n') ?? '', (keywords) =>
            this.module._needle_stream_transcribe_process(
              pcm,
              samples.length,
              settings.language ? language : 0,
              settings.keywords?.length ? keywords : 0,
              this.#output,
              this.config.bufferSize,
            ),
          ),
        );
      } finally {
        this.module._free(pcm);
      }
    }
    if (code < 0) throw this.#error('needle_stream_transcribe');
    const raw = this.#readJson() as Omit<TranscriptionChunk, 'passMs'> & { pass_ms: number };
    if (
      !raw ||
      typeof raw !== 'object' ||
      typeof raw.text !== 'string' ||
      typeof raw.pending !== 'string' ||
      !validWords(raw.words) ||
      (raw.language !== '' && !SPEECH_LANGUAGES.includes(raw.language)) ||
      !nonnegative(raw.received) ||
      !nonnegative(raw.pass_ms)
    )
      throw new NeedleError(
        'INVALID_RESPONSE',
        'Engine returned an unexpected streaming transcription envelope.',
      );
    return {
      text: raw.text,
      words: raw.words,
      pending: raw.pending,
      language: raw.language,
      received: raw.received,
      passMs: raw.pass_ms,
    };
  }

  embed(input: string): Float32Array {
    return this.#withString(input, (pointer) => this.#embedding(pointer, 0, 0));
  }

  embedAudio(audio: AudioInput): Float32Array {
    const { samples } = prepareAudio(audio);
    const pcm = this.#allocate(samples.byteLength);
    try {
      this.module.HEAPU8.set(
        new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength),
        pcm,
      );
      return this.#embedding(0, pcm, samples.length);
    } finally {
      this.module._free(pcm);
    }
  }

  #embedding(pointer: number, pcm: number, samples: number): Float32Array {
    const dimension = this.module._needle_embed(pointer, pcm, samples, 0, 0);
    if (dimension <= 0) throw this.#error('needle_embed');
    if (dimension > 1_048_576)
      throw new NeedleError('INVALID_RESPONSE', `Unexpected embedding dimension: ${dimension}.`);
    const output = this.#allocate(dimension * 4);
    try {
      if (this.module._needle_embed(pointer, pcm, samples, output, dimension) !== dimension)
        throw this.#error('needle_embed');
      // Copy after the call, using the current heap: WASM allocation can grow
      // memory and invalidate earlier views. The copy outlives the next call.
      const embedding = new Float32Array(this.module.HEAPU8.buffer, output, dimension).slice();
      if (!embedding.every(Number.isFinite))
        throw new NeedleError('INVALID_RESPONSE', 'Engine returned a non-finite embedding.');
      return embedding;
    } finally {
      this.module._free(output);
    }
  }

  reset(): void {
    this.module._needle_reset();
  }
}
