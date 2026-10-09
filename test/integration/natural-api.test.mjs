import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import * as needle from '../../dist/index.js';

const weights = process.env.NEEDLE_MODEL_PATH || needle.getModelPath('.cache');
const schema = z.object({ room: z.string(), on: z.boolean() });

test('Python-style constructor runs registered tools and restores tools after extraction', async (t) => {
  const calls = [];
  const agent = new needle.Needle({
    weights,
    stateless: true,
    tools: {
      set_lights: needle.tool({
        description: 'Turn the lights in a room on or off.',
        inputSchema: schema,
        execute: (input) => {
          calls.push(input);
          return { ...input, done: true };
        },
      }),
    },
  });
  t.after(() => agent.close());
  const run = await agent.run('Turn on the kitchen lights');
  assert.equal(run.type, 'respond');
  assert.deepEqual(calls, [{ room: 'kitchen', on: true }]);
  assert.deepEqual(run.results, [{ room: 'kitchen', on: true, done: true }]);
  assert.deepEqual(await agent.extract('room: bedroom, on: false', schema), {
    room: 'bedroom',
    on: false,
  });
  const completion = await agent.complete('Turn off the kitchen lights');
  assert.deepEqual(completion.function_calls, [
    { name: 'set_lights', arguments: { room: 'kitchen', on: false } },
  ]);
  assert.equal(calls.length, 1, 'complete() must not execute callbacks.');
});

test('one-shot extraction and offline lazy loading work with local weights', async (t) => {
  t.mock.method(globalThis, 'fetch', () => {
    throw new Error('Unexpected download');
  });
  const agent = new needle.Needle({ weights, download: false });
  t.after(() => agent.close());
  assert.equal((await agent.embed('kitchen lights')).length, 3072);
  assert.deepEqual(await needle.extract('room: kitchen, on: true', schema, { weights }), {
    room: 'kitchen',
    on: true,
  });
});

test('speech sessions reject text weights with a useful model error', async () => {
  await assert.rejects(needle.createWhistle({ modelPath: weights }), (error) => {
    assert.equal(error.code, 'INVALID_MODEL');
    assert.match(error.message, /Whistle speech weights/);
    return true;
  });
});
