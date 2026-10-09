import { NeedleError, validateInteger, validateText } from '../errors.js';
import type { AudioInput, PcmAudio, TranscriptionSettings } from '../speech.js';

export const SAMPLE_RATE = 16_000;
export const SPEECH_LANGUAGES = ['en', 'de', 'fr', 'es', 'it', 'nl', 'pl'] as const;

function invalid(message: string): never {
  throw new NeedleError('INVALID_ARGUMENT', message);
}

export function transcriptionSettings(options: TranscriptionSettings): TranscriptionSettings {
  const { language, keywords, wordTimestamps } = options;
  if (language !== undefined && !SPEECH_LANGUAGES.includes(language))
    invalid(`language must be one of ${SPEECH_LANGUAGES.join(', ')}.`);
  if (wordTimestamps !== undefined && typeof wordTimestamps !== 'boolean')
    invalid('wordTimestamps must be a boolean.');
  if (keywords !== undefined) {
    if (!Array.isArray(keywords) || keywords.length > 100)
      invalid('keywords must be an array of at most 100 phrases.');
    for (const keyword of keywords) {
      validateText(keyword, 'keyword');
      if (!keyword.trim() || keyword.length > 256 || /[\r\n]/.test(keyword))
        invalid(
          'Each keyword must be a nonempty phrase of at most 256 characters without newlines.',
        );
    }
  }
  return {
    ...(language === undefined ? {} : { language }),
    ...(keywords === undefined ? {} : { keywords: [...keywords] }),
    ...(wordTimestamps === undefined ? {} : { wordTimestamps }),
  };
}

function checkLength(length: number, sampleRate: number): void {
  validateInteger(sampleRate, 'sampleRate', 8_000, 192_000);
  if (!length || length > sampleRate * 30)
    invalid('Audio must contain between one sample and 30 seconds of sound.');
}

/** Decode uncompressed RIFF/WAVE. Encoded formats need an external decoder. */
function wav(bytes: Uint8Array): PcmAudio {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number) => view.getUint32(offset, false);
  if (bytes.length < 12 || tag(0) !== 0x52494646 || tag(8) !== 0x57415645)
    invalid('Expected WAV bytes or mono Float32Array samples. Decode compressed audio first.');
  const end = view.getUint32(4, true) + 8;
  if (end > bytes.length || end < 12) invalid('WAV data is truncated.');
  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let block = 0;
  let data = 0;
  let size = 0;
  let offset = 12;
  for (; offset + 8 <= end; ) {
    const id = tag(offset);
    const length = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (start + length > end) invalid('WAV chunk is truncated.');
    if (id === 0x666d7420) {
      if (format || length < 16) invalid('WAV format chunk is invalid.');
      format = view.getUint16(start, true);
      channels = view.getUint16(start + 2, true);
      sampleRate = view.getUint32(start + 4, true);
      block = view.getUint16(start + 12, true);
      bits = view.getUint16(start + 14, true);
      if (format === 0xfffe) {
        if (
          length < 40 ||
          view.getUint16(start + 16, true) < 22 ||
          view.getUint32(start + 28, true) !== 0x00100000 ||
          view.getUint32(start + 32, false) !== 0x800000aa ||
          view.getUint32(start + 36, false) !== 0x00389b71
        )
          invalid('Unsupported extensible WAV format.');
        format = view.getUint32(start + 24, true);
      }
      if (
        !(
          (format === 1 && [8, 16, 24, 32].includes(bits)) ||
          (format === 3 && [32, 64].includes(bits))
        ) ||
        !channels ||
        channels > 32 ||
        block !== channels * (bits / 8) ||
        view.getUint32(start + 8, true) !== sampleRate * block
      )
        invalid('WAV must contain uncompressed PCM or IEEE float audio.');
    } else if (id === 0x64617461) {
      if (data) invalid('WAV must contain a single data chunk.');
      data = start;
      size = length;
    }
    offset = start + length + (length % 2);
  }
  if (offset !== end || !format || !data || size % block)
    invalid('WAV is missing a valid format or data chunk.');
  const frames = size / block;
  checkLength(frames, sampleRate);
  const samples = new Float32Array(frames);
  const width = bits / 8;
  for (let frame = 0; frame < frames; frame++) {
    let mixed = 0;
    for (let channel = 0; channel < channels; channel++) {
      const at = data + frame * block + channel * width;
      let value: number;
      if (format === 3) value = bits === 32 ? view.getFloat32(at, true) : view.getFloat64(at, true);
      else if (bits === 8) value = (view.getUint8(at) - 128) / 128;
      else if (bits === 16) value = view.getInt16(at, true) / 32768;
      else if (bits === 24) {
        const integer =
          view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getInt8(at + 2) << 16);
        value = integer / 8388608;
      } else value = view.getInt32(at, true) / 2147483648;
      if (!Number.isFinite(value) || Math.abs(value) > 1)
        invalid('Audio samples must be finite numbers in [-1, 1].');
      mixed += value / channels;
    }
    samples[frame] = mixed;
  }
  return { samples, sampleRate };
}

/** Windowed-sinc resampling filters frequencies above the new Nyquist limit. */
function resample(samples: Float32Array, rate: number): Float32Array {
  if (rate === SAMPLE_RATE) return samples;
  const output = new Float32Array(Math.max(1, Math.round((samples.length * SAMPLE_RATE) / rate)));
  const cutoff = Math.min(1, SAMPLE_RATE / rate) * 0.94;
  const radius = Math.ceil(16 / cutoff);
  const kernels = new Map<number, Float64Array>();
  for (let index = 0; index < output.length; index++) {
    const position = index * rate;
    const center = Math.floor(position / SAMPLE_RATE);
    const phase = position % SAMPLE_RATE;
    let kernel = kernels.get(phase);
    if (!kernel) {
      kernel = new Float64Array(radius * 2 + 1);
      for (let tap = -radius; tap <= radius; tap++) {
        const distance = tap - phase / SAMPLE_RATE;
        const angle = Math.PI * distance * cutoff;
        kernel[tap + radius] =
          Math.abs(distance) > radius
            ? 0
            : (angle === 0 ? cutoff : Math.sin(angle) / (Math.PI * distance)) *
              (0.5 + 0.5 * Math.cos((Math.PI * distance) / radius));
      }
      kernels.set(phase, kernel);
    }
    let value = 0;
    let weight = 0;
    for (let tap = -radius; tap <= radius; tap++) {
      const source = center + tap;
      if (source < 0 || source >= samples.length) continue;
      const coefficient = kernel[tap + radius] as number;
      value += (samples[source] as number) * coefficient;
      weight += coefficient;
    }
    output[index] = Math.max(-1, Math.min(1, value / weight));
  }
  return output;
}

/** Runs in the inference worker so decoding/resampling does not block the UI. */
export function prepareAudio(audio: AudioInput): {
  samples: Float32Array;
  durationInSeconds: number;
} {
  let pcm: PcmAudio;
  if (audio instanceof Float32Array) pcm = { samples: audio, sampleRate: SAMPLE_RATE };
  else if (audio instanceof Uint8Array || audio instanceof ArrayBuffer)
    pcm = wav(audio instanceof Uint8Array ? audio : new Uint8Array(audio));
  else if (audio && typeof audio === 'object' && audio.samples instanceof Float32Array) pcm = audio;
  else invalid('audio must be WAV bytes, a Float32Array, or { samples, sampleRate }.');
  checkLength(pcm.samples.length, pcm.sampleRate);
  for (const value of pcm.samples) {
    if (!Number.isFinite(value) || Math.abs(value) > 1)
      invalid('Audio samples must be finite numbers in [-1, 1].');
  }
  return {
    samples: resample(pcm.samples, pcm.sampleRate),
    durationInSeconds: pcm.samples.length / pcm.sampleRate,
  };
}
