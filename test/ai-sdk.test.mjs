import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NoSuchModelError, UnsupportedFunctionalityError } from '@ai-sdk/provider';
import { generateText, jsonSchema } from 'ai';
import { createNeedle, createNeedleProvider, needle } from 'cactus-needle/ai-sdk';
import {
  createNeedle as browserProvider,
  createNeedleProvider as legacyBrowserProvider,
} from 'cactus-needle/ai-sdk/browser';

const tools = {
  lights: {
    inputSchema: jsonSchema({
      type: 'object',
      properties: { on: { type: 'boolean' } },
      required: ['on'],
    }),
  },
};

test('SDK provider factories are lazy, recognize model IDs, and import safely during SSR', () => {
  assert.equal(createNeedleProvider, createNeedle);
  assert.equal(legacyBrowserProvider, browserProvider);
  assert.equal(needle().modelId, 'needle3');
  assert.equal(needle.languageModel().specificationVersion, 'v3');
  assert.equal(needle.embeddingModel().specificationVersion, 'v3');
  assert.equal(needle.transcriptionModel().modelId, 'whistle');
  assert.equal(browserProvider().transcriptionModel().specificationVersion, 'v3');
  assert.equal(browserProvider()().provider, 'needle');
  assert.throws(() => needle('missing'), NoSuchModelError.isInstance);
  assert.throws(() => needle.embeddingModel('missing'), NoSuchModelError.isInstance);
  assert.throws(() => needle.transcriptionModel('needle3'), NoSuchModelError.isInstance);
  assert.throws(() => needle.imageModel('needle3'), NoSuchModelError.isInstance);
});

test('unsupported SDK inputs fail before accessing model weights', async () => {
  const model = createNeedle({ modelPath: '/missing/model.cact' })();
  const invalid = [
    { prompt: 'Write a poem' },
    {
      tools,
      messages: [
        { role: 'user', content: 'on' },
        { role: 'assistant', content: 'Done' },
        { role: 'user', content: 'off' },
      ],
    },
    {
      tools,
      messages: [
        {
          role: 'user',
          content: [{ type: 'file', data: new Uint8Array([1]), mediaType: 'image/png' }],
        },
      ],
    },
  ];
  for (const input of invalid) {
    await assert.rejects(
      generateText({ model, maxRetries: 0, ...input }),
      UnsupportedFunctionalityError.isInstance,
    );
  }
  const prompt = [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }];
  await assert.rejects(
    model.doGenerate({ prompt, responseFormat: { type: 'json' } }),
    UnsupportedFunctionalityError.isInstance,
  );
  await assert.rejects(
    model.doGenerate({
      prompt,
      tools: [{ type: 'provider', id: 'other.search', name: 'search', args: {} }],
    }),
    UnsupportedFunctionalityError.isInstance,
  );
});

test('already-aborted SDK calls propagate the reason without loading a model', async () => {
  const provider = createNeedle({ modelPath: '/missing/model.cact' });
  const controller = new AbortController();
  controller.abort(new Error('cancelled by caller'));
  await assert.rejects(
    provider().doGenerate({
      abortSignal: controller.signal,
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'on' }] }],
    }),
    /cancelled by caller/,
  );
  await assert.rejects(
    provider.embeddingModel().doEmbed({ values: ['hello'], abortSignal: controller.signal }),
    /cancelled by caller/,
  );
});
