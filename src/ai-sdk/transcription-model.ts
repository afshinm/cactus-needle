import {
  type SharedV3Warning,
  type TranscriptionModelV3,
  type TranscriptionModelV3CallOptions,
  UnsupportedFunctionalityError,
} from '@ai-sdk/provider';
import { NeedleError } from '../errors.js';
import { transcriptionSettings } from '../runtime/audio.js';
import type { TranscriptionSettings } from '../speech.js';
import { type WhistleFactory, withSession } from './session.js';

export class NeedleTranscriptionModel implements TranscriptionModelV3 {
  readonly specificationVersion = 'v3';
  readonly provider = 'needle';

  constructor(
    readonly modelId: string,
    private readonly load: WhistleFactory,
  ) {}

  async doGenerate(options: TranscriptionModelV3CallOptions) {
    options.abortSignal?.throwIfAborted();
    const mediaType = options.mediaType.split(';')[0]?.trim().toLowerCase();
    if (!['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/vnd.wave'].includes(mediaType ?? ''))
      throw new UnsupportedFunctionalityError({
        functionality: `Whistle transcription of ${options.mediaType}. Supply an uncompressed WAV file.`,
      });
    const supplied = options.providerOptions?.needle ?? {};
    const settings = transcriptionSettings({
      ...supplied,
      wordTimestamps: supplied.wordTimestamps ?? true,
    } as TranscriptionSettings);
    const warnings: SharedV3Warning[] = [];
    if (
      options.headers &&
      Object.keys(options.headers).some((key) => key.toLowerCase() !== 'user-agent')
    )
      warnings.push({ type: 'unsupported', feature: 'headers', details: 'Inference is local.' });
    for (const key of Object.keys(supplied)) {
      if (!['language', 'keywords', 'wordTimestamps'].includes(key))
        warnings.push({ type: 'unsupported', feature: `providerOptions.needle.${key}` });
    }
    let audio: Uint8Array;
    try {
      audio =
        typeof options.audio === 'string'
          ? Uint8Array.from(atob(options.audio), (character) => character.charCodeAt(0))
          : options.audio;
    } catch (cause) {
      throw new NeedleError(
        'INVALID_ARGUMENT',
        'audio must contain valid base64-encoded WAV data.',
        { cause },
      );
    }
    const timestamp = new Date();
    const result = await withSession(this.load, {}, options.abortSignal, (session) =>
      session.transcribe(audio, settings),
    );
    return {
      text: result.text,
      segments:
        result.words?.map((word) => ({
          text: word.word,
          startSecond: word.start,
          endSecond: word.end,
        })) ?? [],
      language: result.language || undefined,
      durationInSeconds: result.durationInSeconds,
      warnings,
      response: { timestamp, modelId: this.modelId },
      providerMetadata: {
        needle: {
          timeToFirstTokenMs: result.timeToFirstTokenMs,
          tokensPerSecond: result.tokensPerSecond,
        },
      },
    };
  }
}
