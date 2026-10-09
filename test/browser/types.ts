import type { EmbeddingModelV3, LanguageModelV3, ProviderV3 } from '@ai-sdk/provider';
import {
  type BrowserNeedleProviderOptions,
  createNeedleProvider,
  createNeedle as createProvider,
  type NeedleProviderSettings,
} from 'cactus-needle/ai-sdk/browser';
import { createNeedle, tool } from 'cactus-needle/browser';
import { z } from 'zod';

const settings: NeedleProviderSettings = { model: '/models/needle3.cact' };
const legacySettings: BrowserNeedleProviderOptions = settings;
const legacyFactory: typeof createProvider = createNeedleProvider;
const provider: ProviderV3 = createProvider(settings);
void [legacyFactory(legacySettings), legacySettings satisfies NeedleProviderSettings];
const model: LanguageModelV3 = provider.languageModel('needle3');
const embeddingModel: EmbeddingModelV3 = provider.embeddingModel('needle3');
// @ts-expect-error Browser provider does not accept a Node filesystem path.
createProvider({ modelPath: '/tmp/model.cact' });
void [model, embeddingModel];

async function usage() {
  const needle = await createNeedle({
    model: '/models/needle3.cact',
    tools: {
      lights: tool({
        inputSchema: z.object({ room: z.string(), on: z.boolean(), level: z.number().optional() }),
      }),
      weather: tool({
        inputSchema: {
          type: 'object',
          properties: { city: { type: 'string' }, unit: { enum: ['c', 'f'] } },
          required: ['city'],
        },
      }),
    },
    onDownloadProgress({ percentage }) {
      console.log(percentage?.toFixed());
    },
  });
  const { toolCalls } = await needle.generate({
    prompt: 'Turn on the kitchen lights',
    maxOutputTokens: 128,
  });
  for (const call of toolCalls) {
    if (call.toolName === 'lights') {
      const room: string = call.input.room;
      const on: boolean = call.input.on;
      const level: number | undefined = call.input.level;
      // @ts-expect-error The input is inferred from the selected tool, not any.
      const bad: number = call.input.room;
      // @ts-expect-error Inputs are discriminated by toolName.
      call.input.city;
      void [room, on, level, bad];
    } else {
      const city: string = call.input.city;
      const unit: 'c' | 'f' | undefined = call.input.unit;
      // @ts-expect-error Literal enum inputs retain their union.
      const bad: 'kelvin' = call.input.unit;
      void [city, unit, bad];
    }
  }
  // @ts-expect-error Browser options do not accept a Node filesystem path.
  await createNeedle({ modelPath: '/tmp/model.cact' });
  // @ts-expect-error Node's downloader is not exported in the browser entry.
  const { downloadModel } = await import('cactus-needle/browser');
  await needle.close();
  void downloadModel;
}
void usage;
