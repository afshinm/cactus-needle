import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import * as sdk7 from 'ai';
import * as sdk6 from 'ai-v6';
import { getModelPath } from 'cactus-needle';
import { createNeedle } from 'cactus-needle/ai-sdk';
import { z } from 'zod';

globalThis.AI_SDK_LOG_WARNINGS = false;
const modelPath = resolve(process.env.NEEDLE_MODEL_PATH || getModelPath('.cache'));
assert.ok(existsSync(modelPath), 'Run pnpm model:download before AI SDK integration tests.');
const needle = createNeedle({ modelPath });
const schema = z.object({ room: z.string(), on: z.boolean() });
const lightTool = { description: 'Turn the lights in a room on or off.', inputSchema: schema };
const prompt = 'Turn on the kitchen lights';

for (const [version, sdk] of [
  [6, sdk6],
  [7, sdk7],
]) {
  test(`AI SDK ${version}: generateText uses native tool definitions and executes through the SDK`, async () => {
    const executions = [];
    const result = await sdk.generateText({
      model: needle('needle3'),
      prompt,
      tools: {
        set_lights: sdk.tool({
          ...lightTool,
          execute: (input) => {
            executions.push(input);
            return { done: true };
          },
        }),
      },
    });
    assert.deepEqual(
      result.toolCalls.map(({ toolName, input }) => ({ toolName, input })),
      [{ toolName: 'set_lights', input: { room: 'kitchen', on: true } }],
    );
    assert.deepEqual(executions, [{ room: 'kitchen', on: true }]);
    assert.deepEqual(result.toolResults[0].output, { done: true });
    assert.equal(result.finishReason, 'tool-calls');
    assert.ok(result.providerMetadata.needle.confidence > 0);
    assert.deepEqual(result.providerMetadata.needle.suppressed_calls, []);
    assert.equal(result.usage.inputTokens, undefined);
    assert.equal(result.usage.outputTokens, undefined);
    assert.deepEqual(result.warnings, []);
  });

  test(`AI SDK ${version}: streamText emits valid buffered tool events and metadata`, async () => {
    const stream = sdk.streamText({
      model: needle(),
      prompt,
      tools: { set_lights: sdk.tool(lightTool) },
    });
    const events = [];
    for await (const event of stream.fullStream) events.push(event);
    assert.ok(events.some((event) => event.type === 'tool-input-start'));
    assert.ok(events.some((event) => event.type === 'tool-input-end'));
    const call = events.find((event) => event.type === 'tool-call');
    assert.deepEqual(call.input, { room: 'kitchen', on: true });
    assert.equal((await stream.toolCalls)[0].toolCallId, call.toolCallId);
    assert.equal(await stream.finishReason, 'tool-calls');
    assert.ok((await stream.providerMetadata).needle.confidence > 0);
    assert.ok(
      (await stream.warnings).some(
        (warning) => warning.type === 'compatibility' && warning.feature === 'streaming',
      ),
    );
  });

  test(`AI SDK ${version}: object output works through generation and streaming`, async () => {
    const output = sdk.Output.object({ schema });
    const result = await sdk.generateText({
      model: needle(),
      output,
      prompt: 'room: kitchen, on: true',
    });
    assert.deepEqual(result.output, { room: 'kitchen', on: true });
    assert.deepEqual(result.toolCalls, []);
    assert.equal(result.finishReason, 'stop');
    const stream = sdk.streamText({ model: needle(), output, prompt: 'room: kitchen, on: true' });
    let text = '';
    for await (const part of stream.textStream) text += part;
    assert.deepEqual(JSON.parse(text), { room: 'kitchen', on: true });
    assert.deepEqual(await stream.output, { room: 'kitchen', on: true });
  });

  test(`AI SDK ${version}: embeddings and provider registry use real local models`, async () => {
    const registry = sdk.createProviderRegistry({ needle });
    const single = await sdk.embed({ model: needle.embeddingModel(), value: 'kitchen lights' });
    const batch = await sdk.embedMany({
      model: registry.embeddingModel('needle:needle3'),
      values: ['kitchen lights', 'Book a flight to Paris', 'kitchen lights'],
    });
    assert.equal(single.embedding.length, 3072);
    assert.deepEqual(batch.embeddings[0], single.embedding);
    assert.deepEqual(batch.embeddings[2], single.embedding);
    assert.notDeepEqual(batch.embeddings[1], single.embedding);
    const result = await sdk.generateText({
      model: registry.languageModel('needle:needle3'),
      tools: { set_lights: sdk.tool(lightTool) },
      prompt,
    });
    assert.equal(result.toolCalls[0].toolName, 'set_lights');
  });
}

test('SDK calls with changing schemas run concurrently without leaking state', async () => {
  const model = needle();
  const [lights, thermostat] = await Promise.all([
    sdk7.generateText({ model, prompt, tools: { set_lights: sdk7.tool(lightTool) } }),
    sdk7.generateText({
      model,
      prompt: 'Set the thermostat to 21 degrees',
      tools: {
        set_thermostat: sdk7.tool({
          description: 'Set the thermostat temperature in degrees Celsius.',
          inputSchema: z.object({ temperature: z.number().int() }),
        }),
      },
    }),
  ]);
  assert.deepEqual(lights.toolCalls[0].input, { room: 'kitchen', on: true });
  assert.deepEqual(thermostat.toolCalls[0].input, { temperature: 21 });
});

test('SDK tool choice, no-call results, and unsupported settings have explicit behavior', async () => {
  const tools = { set_lights: sdk7.tool(lightTool) };
  const result = await sdk7.generateText({
    model: needle(),
    prompt,
    tools,
    toolChoice: { type: 'tool', toolName: 'set_lights' },
    temperature: 0.5,
    seed: 7,
  });
  assert.equal(result.toolCalls[0].toolName, 'set_lights');
  assert.deepEqual(
    result.warnings.map(({ feature }) => feature),
    ['temperature', 'seed'],
  );
  const offTopic = await sdk7.generateText({
    model: needle(),
    prompt: 'What is the capital of France?',
    tools,
  });
  assert.deepEqual(offTopic.toolCalls, []);
  assert.equal(offTopic.text, '');
  const none = await sdk7.generateText({ model: needle(), prompt, tools, toolChoice: 'none' });
  assert.deepEqual(none.toolCalls, []);
  await assert.rejects(
    sdk7.generateText({
      model: needle(),
      prompt: 'What is the capital of France?',
      tools,
      toolChoice: 'required',
      maxRetries: 0,
    }),
    /withheld/,
  );
});

test('SDK cancellation during setup and buffered streaming leaves the provider reusable', async () => {
  const controller = new AbortController();
  const pending = assert.rejects(
    sdk7.generateText({
      model: needle(),
      prompt,
      tools: { set_lights: sdk7.tool(lightTool) },
      abortSignal: controller.signal,
    }),
    /cancelled/,
  );
  setTimeout(() => controller.abort(new Error('cancelled')), 10);
  await pending;
  const { stream } = await needle().doStream({
    prompt: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    tools: [
      {
        type: 'function',
        name: 'set_lights',
        description: lightTool.description,
        inputSchema: z.toJSONSchema(schema),
      },
    ],
  });
  const reader = stream.getReader();
  assert.equal((await reader.read()).value.type, 'stream-start');
  await reader.cancel();
  const result = await sdk7.embed({ model: needle.embeddingModel(), value: 'still usable' });
  assert.equal(result.embedding.length, 3072);
});
