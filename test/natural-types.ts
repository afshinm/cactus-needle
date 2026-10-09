import { transcribe as sdkTranscribe } from 'ai';
import { experimental_transcribe as sdkTranscribeV6 } from 'ai-v6';
import * as needle from 'cactus-needle';
import { createNeedle as provider } from 'cactus-needle/ai-sdk';
import { z } from 'zod';

// Wrappers can accept either schema format without casting or duplicating overloads.
function defineTool<const Schema extends needle.JsonSchema | needle.StandardJsonSchema>(
  inputSchema: Schema,
) {
  return needle.tool({ inputSchema });
}

async function usage() {
  const schema = z.object({ room: z.string(), on: z.boolean() });
  const typed: needle.Tool<{ room: string; on: boolean }> = defineTool(schema);
  const jsonTool = needle.tool({
    inputSchema: {
      type: 'object',
      properties: { room: { type: 'string' } },
      required: ['room'],
    },
    execute(input) {
      const room: string = input.room;
      // @ts-expect-error Plain JSON schemas also infer callback input types.
      const invalid: number = input.room;
      void invalid;
      return room;
    },
  });
  void [typed, jsonTool];
  const agent = new needle.Needle({
    tools: {
      lights: needle.tool({
        inputSchema: schema,
        execute(input, { abortSignal }) {
          const room: string = input.room;
          const signal: AbortSignal = abortSignal;
          // @ts-expect-error Tool callback arguments are inferred from the schema.
          const invalid: number = input.room;
          void [signal, invalid];
          return { room, on: input.on };
        },
      }),
    },
  });
  const result = await agent.extract('room: kitchen, on: true', schema);
  const room: string | undefined = result?.room;
  const oneShot = await needle.extract('room: bedroom', {
    type: 'object',
    properties: { room: { type: 'string' } },
    required: ['room'],
  });
  const second: string | undefined = oneShot?.room;
  const run: needle.RunResult = await agent.run('Turn on the kitchen lights');
  await agent.run();
  await agent.complete();
  await agent.embed();
  const cancellation: needle.EmbedOptions = { abortSignal: new AbortController().signal };
  await agent.complete('Turn off the lights', cancellation);
  await agent.embed('kitchen', cancellation);
  const speech = new needle.Whistle({ weights: '/models/whistle.cact' });
  const transcription: needle.TranscriptionResult = await speech.transcribe('clip.wav', {
    language: 'en',
    wordTimestamps: true,
  });
  const audio = new Float32Array(16_000);
  await needle.transcribe(audio, { weights: '/models/whistle.cact' });
  for await (const chunk of needle.stream([audio])) {
    const pending: string = chunk.pending;
    void pending;
  }
  await speech.embed({ samples: audio, sampleRate: 16_000 }, cancellation);
  // @ts-expect-error Unsupported language codes are rejected.
  await speech.transcribe(audio, { language: 'xx' });
  // @ts-expect-error Live streams take PCM samples, not encoded bytes.
  speech.stream([new Uint8Array(10)]);
  const model = provider({ speech: { modelPath: '/models/whistle.cact' } }).transcriptionModel();
  await sdkTranscribe({ model, audio: new Uint8Array(10) });
  await sdkTranscribeV6({ model, audio: new Uint8Array(10) });
  await agent.close();
  await speech.close();
  await needle.close();
  void [room, second, run, transcription];
}
void usage;
