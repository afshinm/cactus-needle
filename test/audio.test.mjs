import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareAudio, transcriptionSettings } from '../dist/runtime/audio.js';
import { wav } from './fixtures/audio.mjs';

test('WAV decoding handles PCM widths, floating point, stereo, and byte offsets', () => {
  for (const format of [
    { bits: 8 },
    { bits: 16 },
    { bits: 24 },
    { bits: 32 },
    { bits: 32, float: true },
    { bits: 64, float: true },
  ]) {
    const bytes = wav([-1, 0.5, 0, 0.25], { ...format, channels: 2 });
    const padded = Buffer.concat([Buffer.alloc(7), bytes, Buffer.alloc(3)]);
    const result = prepareAudio(padded.subarray(7, 7 + bytes.length));
    assert.deepEqual([...result.samples], [-0.25, 0.125]);
    assert.equal(result.durationInSeconds, 2 / 16_000);
  }
});

test('WAV chunk alignment accepts metadata and rejects truncated or compressed data', () => {
  const plain = wav([0, 0.5]);
  const junk = Buffer.from([74, 85, 78, 75, 1, 0, 0, 0, 9, 0]);
  const withJunk = Buffer.concat([plain.subarray(0, 12), junk, plain.subarray(12)]);
  withJunk.writeUInt32LE(withJunk.length - 8, 4);
  assert.deepEqual([...prepareAudio(withJunk).samples], [0, 0.5]);
  const compressed = Buffer.from(plain);
  compressed.writeUInt16LE(6, 20);
  const incompleteFrame = Buffer.from(plain);
  incompleteFrame.writeUInt32LE(3, 40);
  for (const invalid of [plain.subarray(0, -1), compressed, incompleteFrame, Buffer.from('mp3')])
    assert.throws(() => prepareAudio(invalid), { code: 'INVALID_ARGUMENT' });
});

test('resampling preserves duration and voice frequencies while removing aliases', () => {
  const tone = (frequency) =>
    Float32Array.from(
      { length: 48_000 },
      (_, i) => 0.5 * Math.sin((2 * Math.PI * frequency * i) / 48_000),
    );
  const voice = prepareAudio({ samples: tone(1000), sampleRate: 48_000 });
  const ultrasonic = prepareAudio({ samples: tone(12_000), sampleRate: 48_000 });
  const rms = (samples) =>
    Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
  assert.equal(voice.durationInSeconds, 1);
  assert.equal(voice.samples.length, 16_000);
  assert.ok(rms(voice.samples) > 0.3);
  assert.ok(rms(ultrasonic.samples.subarray(100, -100)) < 0.005);
  assert.equal(
    prepareAudio({ samples: new Float32Array(8000), sampleRate: 8000 }).samples.length,
    16_000,
  );
});

test('invalid samples, durations, and speech options fail before entering WASM', () => {
  for (const audio of [
    new Float32Array(),
    new Float32Array(480_001),
    new Float32Array([NaN]),
    new Float32Array([1.01]),
    { samples: new Float32Array(1), sampleRate: 0 },
    wav([Infinity], { bits: 32, float: true }),
  ])
    assert.throws(() => prepareAudio(audio), { code: 'INVALID_ARGUMENT' });
  for (const options of [
    { language: 'xx' },
    { wordTimestamps: 'yes' },
    { keywords: 'Needle' },
    { keywords: [''] },
    { keywords: ['two\nlines'] },
    { keywords: ['nul\0byte'] },
  ])
    assert.throws(() => transcriptionSettings(options), { code: 'INVALID_ARGUMENT' });
});
