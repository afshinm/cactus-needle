import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { tool } from '../dist/index.js';
import { configuration } from '../dist/runtime/configuration.js';

test('named tools convert plain JSON Schema and Standard JSON Schema inputs', () => {
  const tools = {
    lights: tool({
      description: 'Control room lights',
      inputSchema: z.object({ room: z.string(), on: z.boolean() }),
    }),
    weather: tool({
      inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    }),
  };
  const serialized = JSON.parse(configuration({ tools }).toolsJson);
  assert.deepEqual(
    serialized.map(({ name }) => name),
    ['lights', 'weather'],
  );
  assert.equal(serialized[0].parameters.type, 'object');
  assert.deepEqual(serialized[0].parameters.required, ['room', 'on']);
  assert.equal(serialized[0].parameters.properties.on.type, 'boolean');
  assert.deepEqual(serialized[1].parameters, tools.weather.inputSchema);
});

test('tool schemas report conversion errors without creating a worker', () => {
  for (const inputSchema of [
    null,
    false,
    { type: 'string' },
    { '~standard': { version: 1 } },
    z.object({ when: z.date() }),
  ]) {
    assert.throws(() => tool({ inputSchema }), { code: 'INVALID_ARGUMENT' });
  }
  assert.throws(
    () => configuration({ tools: { action: { inputSchema: { type: 'object' }, execute() {} } } }),
    { code: 'INVALID_ARGUMENT' },
  );
});
