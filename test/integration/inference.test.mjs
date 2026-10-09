import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { z } from 'zod';
import {
  createNeedle,
  DEFAULT_MODEL,
  downloadModel,
  getModelPath,
  tool,
} from '../../dist/index.js';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const pinned = getModelPath(join(repository, '.cache'));
const modelPath = resolve(
  process.env.NEEDLE_MODEL_PATH ||
    (existsSync(pinned) ? pinned : join(repository, '.cache/needle3.cact')),
);
assert.ok(
  existsSync(modelPath),
  'Run npm run model:download or set NEEDLE_MODEL_PATH before integration tests.',
);

const lights = {
  name: 'set_lights',
  description: 'Turn the lights in a room on or off.',
  parameters: {
    type: 'object',
    properties: { room: { type: 'string' }, on: { type: 'boolean' } },
    required: ['room', 'on'],
  },
};
const thermostat = {
  name: 'set_thermostat',
  description: 'Set the thermostat temperature in degrees Celsius.',
  parameters: {
    type: 'object',
    properties: { temperature: { type: 'integer' } },
    required: ['temperature'],
  },
};

async function session(t, options = {}) {
  const agent = await createNeedle({ modelPath, tools: [lights], ...options });
  t.after(() => agent.close());
  return agent;
}

test('real WASM tool calling runs off the main thread', async (t) => {
  const agent = await session(t);
  let ticks = 0;
  const timer = setInterval(() => ticks++, 2);
  t.after(() => clearInterval(timer));
  const result = await agent.complete('Turn on the kitchen lights');
  assert.equal(result.success, true);
  assert.deepEqual(result.function_calls, [
    { name: 'set_lights', arguments: { room: 'kitchen', on: true } },
  ]);
  assert.ok(result.confidence > 0 && result.confidence <= 1);
  assert.equal(result.peak_ram_mb, null);
  assert.ok(ticks > 0, 'Main thread must remain responsive during inference.');
});

test('friendly generate API accepts Zod and normalizes predicted calls', async (t) => {
  const agent = await session(t, {
    tools: {
      set_lights: tool({
        description: lights.description,
        inputSchema: z.object({ room: z.string(), on: z.boolean() }),
      }),
    },
  });
  const result = await agent.generate({ prompt: 'Turn on the kitchen lights' });
  assert.deepEqual(result.toolCalls, [
    { toolName: 'set_lights', input: { room: 'kitchen', on: true } },
  ]);
  assert.deepEqual(result.suppressedToolCalls, []);
  assert.equal(result.confidence, result.raw.confidence);
  await agent.reset();
  assert.deepEqual(
    (await agent.generate({ prompt: 'What is the capital of France?' })).toolCalls,
    [],
  );
});

test('aborting generation closes the session and rejects queued operations', async (t) => {
  const agent = await session(t);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(agent.generate({ prompt: 'lights on', abortSignal: aborted.signal }), {
    name: 'AbortError',
  });
  assert.equal((await agent.embed('still usable')).length, 3072);
  const active = new AbortController();
  const pending = assert.rejects(
    agent.generate({ prompt: 'lights on', abortSignal: active.signal }),
    { name: 'AbortError' },
  );
  const queued = assert.rejects(agent.embed('queued'), { code: 'CLOSED' });
  active.abort();
  await Promise.all([pending, queued]);
  await assert.rejects(agent.reset(), { code: 'CLOSED' });
});

test('OpenAI-style schemas and simultaneous sessions remain isolated', async (t) => {
  const a = await session(t, { tools: [{ type: 'function', function: lights }] });
  const b = await session(t, { tools: [thermostat] });
  const [lightResult, temperatureResult] = await Promise.all([
    a.complete('Turn on the kitchen lights'),
    b.complete('Set the thermostat to 21 degrees'),
  ]);
  assert.deepEqual(lightResult.function_calls, [
    { name: 'set_lights', arguments: { room: 'kitchen', on: true } },
  ]);
  assert.deepEqual(temperatureResult.function_calls, [
    { name: 'set_thermostat', arguments: { temperature: 21 } },
  ]);
  await a.close();
  await b.reset();
  assert.equal(
    (await b.complete('Set the thermostat to 19 degrees')).function_calls[0].arguments.temperature,
    19,
  );
});

test('stateless sessions serialize overlapping completions', async (t) => {
  const agent = await session(t, { stateless: true });
  const [a, b] = await Promise.all([
    agent.complete('Turn on the kitchen lights'),
    agent.complete('Turn off the bedroom lights'),
  ]);
  assert.deepEqual(a.function_calls[0].arguments, { room: 'kitchen', on: true });
  assert.deepEqual(b.function_calls[0].arguments, { room: 'bedroom', on: false });
  await agent.reset();
  const unrelated = await agent.complete('What is the capital of France?');
  assert.deepEqual(unrelated.function_calls, []);
});

test('one loaded session serializes different request tools and restores defaults', async (t) => {
  const agent = await session(t, { stateless: true });
  const [temperature, light, none, original] = await Promise.all([
    agent.generate({ prompt: 'Set the thermostat to 21 degrees', tools: [thermostat] }),
    agent.generate({ prompt: 'Turn off the bedroom lights', tools: [lights] }),
    agent.generate({ prompt: 'Turn on the kitchen lights', tools: [] }),
    agent.complete('Turn on the kitchen lights'),
  ]);
  assert.deepEqual(temperature.toolCalls, [
    { toolName: 'set_thermostat', input: { temperature: 21 } },
  ]);
  assert.deepEqual(light.toolCalls, [
    { toolName: 'set_lights', input: { room: 'bedroom', on: false } },
  ]);
  assert.deepEqual(none.toolCalls, []);
  assert.deepEqual(original.function_calls, [
    { name: 'set_lights', arguments: { room: 'kitchen', on: true } },
  ]);
  assert.equal((await agent.embed('still loaded')).length, 3072);
});

test('invalid request tools and failed reconfiguration leave the model reusable', async (t) => {
  const agent = await session(t, { stateless: true });
  await assert.rejects(agent.generate({ prompt: 'lights on', tools: [lights, lights] }), {
    code: 'INVALID_ARGUMENT',
  });
  await assert.rejects(
    agent.generate({
      prompt: 'lights on',
      tools: [{ ...lights, description: 'facts '.repeat(10_000) }],
    }),
    { code: 'ENGINE_ERROR' },
  );
  const result = await agent.generate({ prompt: 'Turn on the kitchen lights' });
  assert.deepEqual(result.toolCalls, [
    { toolName: 'set_lights', input: { room: 'kitchen', on: true } },
  ]);
});

test('embeddings own their memory across later calls and shutdown', async (t) => {
  const agent = await session(t);
  const first = await agent.embed('Turn on the kitchen lights');
  assert.ok(first instanceof Float32Array);
  assert.equal(first.length, 3072);
  assert.ok(first.every(Number.isFinite));
  assert.ok(first.some((value) => value !== 0));
  const snapshot = first.slice();
  const second = await agent.embed('Book a flight to Paris');
  assert.notDeepEqual(first, second);
  await agent.close();
  assert.deepEqual(first, snapshot);
});

test('close rejects pending operations and is idempotent', async (t) => {
  const agent = await session(t);
  const pending = assert.rejects(agent.complete('Turn on the kitchen lights'), { code: 'CLOSED' });
  await Promise.all([agent.close(), agent.close(), pending]);
  await assert.rejects(agent.complete('Turn off the kitchen lights'), { code: 'CLOSED' });
  await assert.rejects(agent.embed('hello'), { code: 'CLOSED' });
  await assert.rejects(agent.reset(), { code: 'CLOSED' });
});

test('input errors do not poison a loaded session', async (t) => {
  const agent = await session(t);
  await assert.rejects(agent.complete('lights\0off'), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(agent.complete('lights off', { maxNewTokens: NaN }), {
    code: 'INVALID_ARGUMENT',
  });
  const result = await agent.complete('Turn on the kitchen lights');
  assert.equal(result.function_calls[0].name, 'set_lights');
});

test('engine initialization errors preserve the context-limit explanation', async () => {
  await assert.rejects(
    createNeedle({ modelPath, tools: [lights], system: 'facts '.repeat(10_000) }),
    (error) => {
      assert.equal(error.code, 'ENGINE_ERROR');
      assert.match(error.message, /prefix|context|token/i);
      return true;
    },
  );
});

test('inference inherits network-denying preloads with process-wide Node flags', async () => {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      '--max-old-space-size=256',
      '--title=needle-inference-test',
      '--import',
      new URL('../fixtures/deny-network.mjs', import.meta.url).href,
      fileURLToPath(new URL('../fixtures/offline-client.mjs', import.meta.url)),
      modelPath,
    ],
    { timeout: 30_000 },
  );
  assert.match(stdout, /offline inference passed/);
});

test('download verifies real weights, caches them, and refuses a corrupted cache', async (t) => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'needle-cache-'));
  t.after(() => rm(cacheDir, { recursive: true, force: true }));
  const bytes = await readFile(modelPath);
  assert.equal(bytes.length, DEFAULT_MODEL.size, 'This test needs the pinned base model.');
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response(bytes));
  const progress = [];
  const path = await downloadModel({
    cacheDir,
    onProgress: (value) => progress.push(value.receivedBytes),
  });
  assert.equal(path, getModelPath(cacheDir));
  assert.equal(progress.at(-1), DEFAULT_MODEL.size);
  assert.equal(await downloadModel({ cacheDir }), path);
  assert.equal(fetch.mock.callCount(), 1);
  assert.deepEqual(await readdir(dirname(path)), ['needle3.cact']);
  const cached = await createNeedle({ cacheDir, tools: [lights] });
  try {
    assert.equal(
      (await cached.complete('Turn on the kitchen lights')).function_calls[0].name,
      'set_lights',
    );
  } finally {
    await cached.close();
  }
  bytes[1000] ^= 1;
  await writeFile(path, bytes);
  await assert.rejects(downloadModel({ cacheDir }), { code: 'INTEGRITY_ERROR' });
  await assert.rejects(createNeedle({ cacheDir }), { code: 'INTEGRITY_ERROR' });
  assert.equal(fetch.mock.callCount(), 1);
});

test('a prepopulated cache loads without fetch or download registration', async (t) => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'needle-airgap-'));
  t.after(() => rm(cacheDir, { recursive: true, force: true }));
  const path = getModelPath(cacheDir);
  await mkdir(dirname(path), { recursive: true });
  await copyFile(modelPath, path);
  const fetch = t.mock.method(globalThis, 'fetch', () => {
    throw new Error('Unexpected network request');
  });
  assert.equal(await downloadModel({ cacheDir }), path);
  const agent = await session(t, { modelPath: undefined, cacheDir });
  assert.equal((await agent.embed('air-gapped inference')).length, 3072);
  assert.equal(fetch.mock.callCount(), 0);
});
