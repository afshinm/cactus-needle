import { NeedleError } from './errors.js';
import { transcriptionSettings } from './runtime/audio.js';
import { Resident } from './runtime/resident.js';
import type {
  AudioInput,
  AudioSource,
  SpeechSession,
  StreamOptions,
  TranscribeOptions,
  TranscriptionChunk,
  TranscriptionResult,
  Whistle,
} from './speech.js';
import type { EmbedOptions } from './types.js';

export type ReadAudio = (source: AudioSource, signal: AbortSignal) => Promise<AudioInput>;

export class SpeechClient extends Resident<SpeechSession> implements Whistle {
  #stream: AbortController | undefined;
  constructor(
    load: (signal: AbortSignal) => Promise<SpeechSession>,
    private readonly read: ReadAudio,
  ) {
    super(load);
  }

  async transcribe(
    audio: AudioSource,
    options: TranscribeOptions = {},
  ): Promise<TranscriptionResult> {
    options.abortSignal?.throwIfAborted();
    this.#available();
    const settings = transcriptionSettings(options);
    return this.use(async (session, signal) => {
      const input = await this.read(audio, signal);
      signal.throwIfAborted();
      return session.transcribe(input, settings);
    }, options.abortSignal);
  }

  async embed(audio: AudioSource, options: EmbedOptions = {}): Promise<Float32Array> {
    options.abortSignal?.throwIfAborted();
    this.#available();
    return this.use(async (session, signal) => {
      const input = await this.read(audio, signal);
      signal.throwIfAborted();
      return session.embedAudio(input);
    }, options.abortSignal);
  }

  #available(): void {
    this.assertOpen();
    if (this.#stream)
      throw new NeedleError(
        'INVALID_ARGUMENT',
        'Finish or close the active transcription stream first.',
      );
  }

  async *stream(
    chunks: AsyncIterable<Float32Array> | Iterable<Float32Array>,
    options: StreamOptions = {},
  ): AsyncIterableIterator<TranscriptionChunk> {
    options.abortSignal?.throwIfAborted();
    this.#available();
    const settings = transcriptionSettings(options);
    const controller = new AbortController();
    this.#stream = controller;
    const signal = options.abortSignal
      ? AbortSignal.any([controller.signal, options.abortSignal])
      : controller.signal;
    const abort = () => {
      void this.close();
    };
    options.abortSignal?.addEventListener('abort', abort, { once: true });
    let rejectCancelled!: (reason: unknown) => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      rejectCancelled = reject;
    });
    // A consumer may pause at yield while cancellation arrives.
    void cancelled.catch(() => {});
    const onCancel = () =>
      rejectCancelled(options.abortSignal?.aborted ? options.abortSignal.reason : signal.reason);
    signal.addEventListener('abort', onCancel, { once: true });
    let iterator: AsyncIterator<Float32Array> | Iterator<Float32Array> | undefined;
    let started = false;
    let finished = false;
    try {
      iterator =
        Symbol.asyncIterator in chunks ? chunks[Symbol.asyncIterator]() : chunks[Symbol.iterator]();
      while (true) {
        signal.throwIfAborted();
        const next = await Promise.race([iterator.next(), cancelled]);
        if (next.done) break;
        started = true;
        yield await this.use((session) => session.streamTranscribe(next.value, settings), signal);
      }
      if (started) {
        const tail = await this.use(
          (session) => session.streamTranscribe(undefined, settings),
          signal,
        );
        finished = true;
        yield tail;
      }
    } finally {
      options.abortSignal?.removeEventListener('abort', abort);
      signal.removeEventListener('abort', onCancel);
      if (started && !finished && !signal.aborted) {
        try {
          await this.use((session) => session.streamTranscribe(undefined, settings));
        } catch {
          await this.close();
        }
      }
      this.#stream = undefined;
      if (iterator?.return) {
        const cleanup = Promise.resolve().then(() => iterator?.return?.());
        if (signal.aborted) void cleanup.catch(() => {});
        else await cleanup;
      }
    }
  }

  override close(): Promise<void> {
    this.#stream?.abort(new NeedleError('CLOSED', 'This transcription stream was closed.'));
    return super.close();
  }
}
