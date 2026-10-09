import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { transcribe } from 'ai';
import { experimental_transcribe as transcribeV6 } from 'ai-v6';
import { createNeedle } from '../../dist/ai-sdk/index.js';
import { createWhistle, getModelPath, transcribe as oneShot, Whistle } from '../../dist/index.js';
import { wav } from '../fixtures/audio.mjs';

const weights = process.env.WHISTLE_MODEL_PATH || getModelPath('.cache', 'whistle');
assert.ok(
  existsSync(weights),
  'Run pnpm model:download or set WHISTLE_MODEL_PATH before speech integration tests.',
);
const silence = new Float32Array(16_000);

test('real Whistle handles PCM, WAV paths, reuse, and audio embeddings', async (t) => {
  const speech = new Whistle({ weights, download: false });
  t.after(() => speech.close());
  const directory = await mkdtemp(join(tmpdir(), 'whistle-audio-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'silence.wav');
  await writeFile(path, wav(silence));
  for (const audio of [silence, path, pathToFileURL(path)]) {
    const result = await speech.transcribe(audio, { wordTimestamps: true });
    assert.equal(result.text, '');
    assert.equal(result.durationInSeconds, 1);
    assert.deepEqual(result.words, []);
    assert.ok(Number.isFinite(result.timeToFirstTokenMs));
    assert.ok(Number.isFinite(result.tokensPerSecond));
  }
  const features = await speech.embed(silence);
  assert.ok(features.length > 0);
  assert.ok(features.every(Number.isFinite));
  assert.equal((await oneShot(path, { weights })).text, '');
  await assert.rejects(speech.transcribe(new Float32Array([NaN])), { code: 'INVALID_ARGUMENT' });
  assert.equal((await speech.transcribe(silence)).text, '');
});

test('real Whistle streams flush and reset without reloading the model', async (t) => {
  const speech = await createWhistle({ modelPath: weights });
  t.after(() => speech.close());
  for (let pass = 0; pass < 2; pass++) {
    const result = [];
    for await (const chunk of speech.stream([silence, silence])) result.push(chunk);
    assert.equal(result.length, 3);
    assert.equal(result.at(-1).received, 2);
    assert.equal(result.map((value) => value.text).join(''), '');
    assert.ok(result.every((value) => Number.isFinite(value.passMs)));
  }
});

for (const [version, sdk] of [
  ['7', transcribe],
  ['6', transcribeV6],
]) {
  test(`AI SDK ${version} runs real Whistle transcription`, async () => {
    const provider = createNeedle({ speech: { modelPath: weights } });
    const result = await sdk({
      model: provider.transcriptionModel(),
      audio: wav(silence),
      maxRetries: 0,
    });
    assert.equal(result.text, '');
    assert.equal(result.durationInSeconds, 1);
    assert.deepEqual(result.segments, []);
  });
}
