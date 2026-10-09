/// <reference lib="esnext.disposable" preserve="true" />

/** Mono float samples in [-1, 1]. */
export interface PcmAudio {
  samples: Float32Array;
  sampleRate: number;
}

/** WAV bytes, 16 kHz mono samples, or mono samples with an explicit sample rate. */
export type AudioInput = Uint8Array | ArrayBuffer | Float32Array | PcmAudio;
/** Node accepts local paths/file: URLs; browsers accept URLs and File/Blob objects. */
export type AudioSource = AudioInput | string | URL | Blob;
export type SpeechLanguage = 'en' | 'de' | 'fr' | 'es' | 'it' | 'nl' | 'pl';

export interface TranscriptionSettings {
  /** Omit to detect the language. */
  language?: SpeechLanguage;
  /** Names and phrases to favour during decoding. */
  keywords?: readonly string[];
  wordTimestamps?: boolean;
}

export interface TranscribeOptions extends TranscriptionSettings {
  /** Aborting inference closes the session and cancels its queued operations. */
  abortSignal?: AbortSignal;
}

export interface TranscriptWord {
  word: string;
  start: number;
  end: number;
  probability: number;
}

export interface TranscriptionResult {
  text: string;
  /** Empty for silence. */
  language: SpeechLanguage | '';
  durationInSeconds: number;
  words?: TranscriptWord[];
  /** Engine timing in milliseconds and tokens per second. */
  timeToFirstTokenMs: number;
  tokensPerSecond: number;
}

export type StreamOptions = Omit<TranscribeOptions, 'wordTimestamps'>;
export interface TranscriptionChunk {
  /** Newly committed text; append it to the transcript. */
  text: string;
  words: TranscriptWord[];
  /** Unconfirmed tail; replace the previous pending text. */
  pending: string;
  language: SpeechLanguage | '';
  /** Audio received so far, in seconds. */
  received: number;
  passMs: number;
}

/** A resident Whistle model in its own worker. Requests are serialized. */
export interface Whistle {
  /** At most 30 seconds. WAV channels are mixed to mono and resampled to 16 kHz. */
  transcribe(audio: AudioSource, options?: TranscribeOptions): Promise<TranscriptionResult>;
  /** Flattened encoder features, one row per 80 ms frame. */
  embed(audio: AudioSource, options?: { abortSignal?: AbortSignal }): Promise<Float32Array>;
  /** Live 16 kHz mono chunks, usually one second each. Only one stream per session. */
  stream(
    chunks: AsyncIterable<Float32Array> | Iterable<Float32Array>,
    options?: StreamOptions,
  ): AsyncIterableIterator<TranscriptionChunk>;
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

/** Internal worker interface; audio files are resolved by each platform's client. */
export interface SpeechSession {
  transcribe(audio: AudioInput, options?: TranscribeOptions): Promise<TranscriptionResult>;
  embedAudio(audio: AudioInput): Promise<Float32Array>;
  streamTranscribe(
    audio: Float32Array | undefined,
    settings: TranscriptionSettings,
  ): Promise<TranscriptionChunk>;
  close(): Promise<void>;
}
