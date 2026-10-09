// Run in a browser module after installing the package in a bundler project.
import { createNeedle, tool } from 'cactus-needle/browser';

const needle = await createNeedle({
  onDownloadProgress: ({ percentage }) =>
    console.log(`Loading model: ${percentage?.toFixed(0) ?? '?'}%`),
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
  const { toolCalls, confidence } = await needle.generate({ prompt: 'Turn on the kitchen lights' });
  console.log(toolCalls, confidence);
  console.log('Embedding dimensions:', (await needle.embed('kitchen lights')).length);
} finally {
  await needle.close();
}
