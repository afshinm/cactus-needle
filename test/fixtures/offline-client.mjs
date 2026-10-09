import assert from 'node:assert/strict';
import { createNeedle } from '../../dist/index.js';

const agent = await createNeedle({
  modelPath: process.argv[2],
  stateless: true,
  tools: [
    {
      name: 'set_lights',
      description: 'Turn the lights in a room on or off.',
      parameters: {
        type: 'object',
        properties: { room: { type: 'string' }, on: { type: 'boolean' } },
        required: ['room', 'on'],
      },
    },
  ],
});
try {
  const result = await agent.complete('Turn on the kitchen lights');
  assert.deepEqual(result.function_calls, [
    { name: 'set_lights', arguments: { room: 'kitchen', on: true } },
  ]);
  assert.equal((await agent.embed('kitchen lights')).length, 3072);
  console.log('offline inference passed');
} finally {
  await agent.close();
}
