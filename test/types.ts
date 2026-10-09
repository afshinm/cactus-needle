import {
  type CompletionResult,
  createNeedle,
  downloadModel,
  type Needle,
  type ToolDefinition,
} from '../src/index.js';

const tools = [
  {
    type: 'function',
    function: {
      name: 'set_lights',
      parameters: {
        type: 'object',
        properties: { room: { type: 'string' }, on: { type: 'boolean' } },
        required: ['room', 'on'],
      },
    },
  },
] as const satisfies readonly ToolDefinition[];

async function usage() {
  const agent: Needle = await createNeedle({ tools, modelPath: new URL('file:///tmp/model.cact') });
  const result: CompletionResult = await agent.complete('lights on', { maxNewTokens: 128 });
  const embedding: Float32Array = await agent.embed('lights');
  await agent.reset();
  await agent.close();
  await agent[Symbol.asyncDispose]();
  await downloadModel({ onProgress: ({ receivedBytes }) => console.log(receivedBytes.toFixed()) });
  // @ts-expect-error tool schemas are objects, not callable JavaScript functions
  await createNeedle({ tools: [() => {}] });
  // @ts-expect-error tokens must be numbers
  await agent.complete('test', { maxNewTokens: '128' });
  // @ts-expect-error embeddings are typed arrays
  const strings: string[] = embedding;
  return { result, embedding, strings };
}
void usage;
