import type {
  EmbeddingModelV3,
  LanguageModelV3,
  ProviderV3,
  TranscriptionModelV3,
} from '@ai-sdk/provider';
import {
  type BrowserNeedleProviderOptions,
  createNeedleProvider,
  createNeedle as createProvider,
  type NeedleProviderSettings,
} from 'cactus-needle/ai-sdk/browser';
import { createNeedle, Needle, tool, transcribe, Whistle } from 'cactus-needle/browser';
import { z } from 'zod';

const settings: NeedleProviderSettings = { model: '/models/needle3.cact' };
const legacySettings: BrowserNeedleProviderOptions = settings;
const legacyFactory: typeof createProvider = createNeedleProvider;
const provider: ProviderV3 = createProvider(settings);
void [legacyFactory(legacySettings), legacySettings satisfies NeedleProviderSettings];
const model: LanguageModelV3 = provider.languageModel('needle3');
const embeddingModel: EmbeddingModelV3 = provider.embeddingModel('needle3');
const speechModel: TranscriptionModelV3 = createProvider({
  speech: { model: '/whistle.cact' },
}).transcriptionModel();
// @ts-expect-error Browser provider does not accept a Node filesystem path.
createProvider({ modelPath: '/tmp/model.cact' });
void [model, embeddingModel, speechModel];

async function usage() {
  const speech = new Whistle({ weights: '/models/whistle.cact' });
  const speechText: string = (await speech.transcribe(new File([], 'clip.wav'))).text;
  await transcribe(new Float32Array(16_000), { offline: true });
  for await (const part of speech.stream([new Float32Array(16_000)])) console.log(part.pending);
  const lazy = new Needle({ weights: '/models/needle3.cact' });
  await lazy.close();
  await speech.close();
  // @ts-expect-error Browser speech constructors do not accept filesystem paths.
  new Whistle({ modelPath: '/tmp/whistle.cact' });
  void speechText;
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
  const switched = await needle.generate({
    prompt: 'Set the tempo to 120',
    tools: {
      set_tempo: tool({
        inputSchema: {
          type: 'object',
          properties: { bpm: { type: 'integer' } },
          required: ['bpm'],
        },
      }),
    },
  });
  for (const call of switched.toolCalls) {
    const name: 'set_tempo' = call.toolName;
    const bpm: number = call.input.bpm;
    // @ts-expect-error Request tools replace the creation-time tools.
    call.input.room;
    void [name, bpm];
  }
  const defaults = await needle.generate({ prompt: 'lights on' });
  // @ts-expect-error A request's tools do not change the default result type.
  const tempoName: 'set_tempo' = defaults.toolCalls[0]?.toolName;
  void tempoName;
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
