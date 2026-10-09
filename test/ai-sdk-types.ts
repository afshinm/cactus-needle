import {
  createProviderRegistry,
  embed,
  embedMany,
  generateText,
  Output,
  streamText,
  tool,
} from 'ai';
import { embed as embedV6, generateText as generateV6, tool as toolV6 } from 'ai-v6';
import {
  createNeedle,
  createNeedleProvider,
  type NeedleProvider,
  type NeedleProviderOptions,
  type NeedleProviderSettings,
} from 'cactus-needle/ai-sdk';
import { z } from 'zod';

async function usage() {
  const settings: NeedleProviderSettings = { modelPath: '/models/needle3.cact' };
  const legacySettings: NeedleProviderOptions = settings;
  const legacyFactory: typeof createNeedle = createNeedleProvider;
  const needle: NeedleProvider = createNeedle(settings);
  void [legacyFactory(legacySettings), legacySettings satisfies NeedleProviderSettings];
  const tools = { lights: { inputSchema: z.object({ room: z.string(), on: z.boolean() }) } };
  const result = await generateText({ model: needle(), tools, prompt: 'kitchen lights on' });
  for (const call of result.toolCalls) {
    if (call.dynamic) continue;
    const room: string = call.input.room;
    // @ts-expect-error The AI SDK preserves the tool input type.
    const invalid: number = call.input.room;
    void [room, invalid];
  }
  await generateV6({
    model: needle(),
    tools: { lights: toolV6({ inputSchema: z.object({ room: z.string(), on: z.boolean() }) }) },
    prompt: 'lights on',
  });
  await embedV6({ model: needle.embeddingModel(), value: 'hello' });
  await streamText({ model: needle(), tools, prompt: 'lights on' }).toolCalls;
  await generateText({
    model: needle(),
    prompt: 'lights on',
    tools: {
      lights: tool({ inputSchema: z.object({ on: z.boolean() }), execute: ({ on }) => ({ on }) }),
    },
  });
  await generateText({
    model: needle(),
    output: Output.object({ schema: z.object({ room: z.string() }) }),
    prompt: 'room: kitchen',
  });
  const registry = createProviderRegistry({ needle });
  await embed({ model: registry.embeddingModel('needle:needle3'), value: 'hello' });
  await embedMany({ model: needle.embeddingModel(), values: ['a', 'b'] });
  // @ts-expect-error Tool definitions belong to generateText, not provider setup.
  createNeedle({ tools });
}
void usage;
