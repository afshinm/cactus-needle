// From a checkout: pnpm model:download && node examples/ai-sdk.mjs
import { fileURLToPath } from 'node:url';
import { embed, generateText, Output } from 'ai';
import { createNeedle } from 'cactus-needle/ai-sdk';
import { z } from 'zod';

const needle = createNeedle({ cacheDir: fileURLToPath(new URL('../.cache/', import.meta.url)) });
const inputSchema = z.object({ room: z.string(), on: z.boolean() });

const result = await generateText({
  model: needle('needle3'),
  tools: {
    set_lights: {
      description: 'Turn the lights in a room on or off.',
      inputSchema,
    },
  },
  prompt: 'Turn on the kitchen lights',
});
console.log(result.toolCalls);
console.log('Confidence:', result.providerMetadata?.needle?.confidence);

const { output } = await generateText({
  model: needle(),
  output: Output.object({ schema: inputSchema }),
  prompt: 'room: kitchen, on: true',
});
console.log('Structured output:', output);
const { embedding } = await embed({ model: needle.embeddingModel(), value: 'kitchen lights' });
console.log('Embedding dimensions:', embedding.length);
