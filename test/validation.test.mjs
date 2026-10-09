import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createNeedle, NeedleError } from '../dist/index.js';

test('missing model fails locally with instructions for an explicit download', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'needle-missing-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(createNeedle({ modelPath: join(directory, 'missing.cact') }), (error) => {
    assert.ok(error instanceof NeedleError);
    assert.equal(error.code, 'MODEL_NOT_FOUND');
    assert.match(error.message, /downloadModel/);
    return true;
  });
});

test('invalid or truncated models are rejected before inference', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'needle-invalid-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'model.cact');
  for (const content of [
    Buffer.from('not a model'),
    Buffer.alloc(196),
    (() => {
      const bytes = Buffer.alloc(196);
      bytes.writeUInt32LE(0x05e12a84, 0);
      bytes.writeUInt32LE(1000, 4);
      return bytes;
    })(),
  ]) {
    await writeFile(path, content);
    await assert.rejects(createNeedle({ modelPath: path }), { code: 'INVALID_MODEL' });
  }
});

test('invalid configuration fails before creating a worker', async () => {
  const tool = { name: 'lights', parameters: { type: 'object' } };
  const circular = { ...tool };
  circular.parameters.loop = circular;
  for (const options of [
    { modelPath: new URL('https://example.com/model.cact') },
    { modelPath: '' },
    { system: 'facts\0ignored' },
    { maxNewTokens: 0 },
    { maxNewTokens: 1.5 },
    { bufferSize: Infinity },
    { stateless: 'yes' },
    { tools: { lights: {} } },
    { tools: [42] },
    { tools: [null] },
    { tools: [{ name: 'lights' }] },
    { tools: [tool, tool] },
    { tools: [circular] },
    { tools: [{ ...tool, description: () => 'not serializable' }] },
  ]) {
    await assert.rejects(createNeedle(options), { code: 'INVALID_ARGUMENT' });
  }
});
