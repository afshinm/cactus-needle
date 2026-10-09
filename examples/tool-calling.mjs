// From a checkout: npm run model:download && node examples/tool-calling.mjs
import { fileURLToPath } from 'node:url';
import { createNeedle, tool } from '../dist/index.js';

const agent = await createNeedle({
  cacheDir: fileURLToPath(new URL('../.cache/', import.meta.url)),
  stateless: true,
  tools: {
    set_lights: tool({
      description: 'Turn the lights in a room on or off.',
      inputSchema: {
        type: 'object',
        properties: { room: { type: 'string' }, on: { type: 'boolean' } },
        required: ['room', 'on'],
      },
    }),
  },
});

try {
  console.log(await agent.generate({ prompt: 'Turn on the kitchen lights' }));
  console.log('Embedding dimensions:', (await agent.embed('kitchen lights')).length);
} finally {
  await agent.close();
}
