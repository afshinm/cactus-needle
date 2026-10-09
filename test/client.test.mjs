import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { Agent } from '../dist/client.js';
import { NeedleError, tool } from '../dist/index.js';
import { shortcuts } from '../dist/shortcuts.js';
import { SpeechClient } from '../dist/speech-client.js';

const response = (calls = [], extra = {}) => ({
  success: true,
  type: calls.length ? 'call' : 'respond',
  function_calls: calls,
  suppressed_calls: [],
  ...extra,
});
const chunk = { text: '', words: [], pending: '', language: '', received: 1, passMs: 0 };

test('run serializes the whole tool loop, keeps its context, and never executes suppressed calls', async (t) => {
  const events = [];
  let loaded = 0;
  const session = {
    async reset() {
      events.push('reset');
    },
    async complete(input) {
      events.push(input);
      return input.startsWith('[')
        ? response()
        : response([{ name: 'lights', arguments: { on: true } }], {
            suppressed_calls: [{ name: 'lights', arguments: { on: false } }],
          });
    },
    async close() {},
  };
  const agent = new Agent(
    async () => {
      loaded++;
      return session;
    },
    {
      stateless: true,
      tools: {
        lights: tool({
          inputSchema: z.object({ on: z.boolean() }),
          execute: async ({ on }) => {
            events.push(`execute:${on}`);
            return { on };
          },
        }),
      },
    },
  );
  t.after(() => agent.close());
  const [first, second] = await Promise.all([agent.run('first'), agent.run('second')]);
  assert.equal(loaded, 1);
  assert.deepEqual(first.results, [{ on: true }]);
  assert.deepEqual(second.results, [{ on: true }]);
  assert.deepEqual(events, [
    'reset',
    'first',
    'execute:true',
    '[{"on":true}]',
    'reset',
    'second',
    'execute:true',
    '[{"on":true}]',
  ]);
});

test('run withholds ungrounded and schema-invalid calls and reports callback failures', async (t) => {
  const executed = [];
  const agent = new Agent(
    async () => ({
      async complete(input) {
        if (input.startsWith('[')) return response();
        return response(
          [
            { name: 'unsafe', arguments: { on: true } },
            { name: 'invalid', arguments: { on: 'yes' } },
            { name: 'fails', arguments: { on: true } },
          ],
          { validation: { ungrounded: ['unsafe.on'] } },
        );
      },
      async close() {},
    }),
    {
      tools: Object.fromEntries(
        ['unsafe', 'invalid', 'fails'].map((name) => [
          name,
          tool({
            inputSchema: z.object({ on: z.boolean() }),
            execute() {
              executed.push(name);
              throw new Error('Device disconnected');
            },
          }),
        ]),
      ),
    },
  );
  t.after(() => agent.close());
  const result = await agent.run('on');
  assert.deepEqual(executed, ['fails']);
  assert.equal(result.results.length, 3);
  assert.ok(result.results.every((value) => typeof value.error === 'string'));
  assert.equal(result.results[2].error, 'Device disconnected');
});

test('extract checks grounding and schema refinements and leaves withheld predictions withheld', async (t) => {
  let output;
  const agent = new Agent(
    async () => ({
      async reset() {},
      async complete() {
        return output;
      },
      async close() {},
    }),
    {},
  );
  t.after(() => agent.close());
  const schema = z.object({ room: z.string().refine((value) => value !== 'unknown') });
  output = response([{ name: 'extract', arguments: { room: 'kitchen' } }]);
  assert.deepEqual(await agent.extract('room: kitchen', schema), { room: 'kitchen' });
  output.validation = { ungrounded: ['extract.room'] };
  await assert.rejects(agent.extract('no room', schema), { name: 'ExtractionValidationError' });
  assert.deepEqual(await agent.extract('no room', schema, { strict: false }), { room: 'kitchen' });
  output = response([{ name: 'extract', arguments: { room: 'unknown' } }]);
  await assert.rejects(agent.extract('room: unknown', schema), { code: 'INVALID_ARGUMENT' });
  output = response([], {
    suppressed_calls: [{ name: 'extract', arguments: { room: 'kitchen' } }],
  });
  assert.equal(await agent.extract('no room', schema), null);
});

test('aborting a tool callback rejects queued work and preserves the caller reason', async () => {
  let started;
  let callbackSignal;
  let closed = 0;
  const running = new Promise((resolve) => {
    started = resolve;
  });
  const controller = new AbortController();
  const agent = new Agent(
    async () => ({
      async complete() {
        return response([{ name: 'wait', arguments: {} }]);
      },
      async close() {
        closed++;
      },
    }),
    {
      tools: {
        wait: tool({
          inputSchema: { type: 'object' },
          execute(_input, { abortSignal }) {
            callbackSignal = abortSignal;
            started();
            return new Promise((_resolve, reject) =>
              abortSignal.addEventListener('abort', () => reject(abortSignal.reason), {
                once: true,
              }),
            );
          },
        }),
      },
    },
  );
  const reason = new Error('Stop this operation');
  const pending = assert.rejects(
    agent.run('wait', { abortSignal: controller.signal }),
    (error) => error === reason,
  );
  const queued = assert.rejects(agent.reset(), { code: 'CLOSED' });
  await running;
  controller.abort(reason);
  await Promise.all([pending, queued, agent.close()]);
  assert.equal(callbackSignal.aborted, true);
  assert.equal(closed, 1);
});

test('speech streams are exclusive, flush on early return, and keep their model loaded', async (t) => {
  let loaded = 0;
  let flushed = 0;
  let received = 0;
  const speech = new SpeechClient(
    async () => {
      loaded++;
      return {
        async streamTranscribe(audio) {
          if (audio === undefined) flushed++;
          else received++;
          return chunk;
        },
        async transcribe() {
          return { text: 'ready' };
        },
        async close() {},
      };
    },
    async (input) => input,
  );
  t.after(() => speech.close());
  for await (const value of speech.stream([new Float32Array(16_000), new Float32Array(16_000)])) {
    assert.equal(value, chunk);
    await assert.rejects(speech.transcribe(new Float32Array(1)), /active transcription stream/);
    break;
  }
  assert.equal(received, 1);
  assert.equal(flushed, 1);
  assert.equal((await speech.transcribe(new Float32Array(1))).text, 'ready');
  const result = [];
  for await (const value of speech.stream([new Float32Array(16_000)])) result.push(value);
  assert.equal(result.length, 2, 'The normal end includes the flushed tail.');
  assert.equal(flushed, 2);
  assert.equal(loaded, 1);
});

test('cancellation interrupts a speech stream even while its producer is waiting', async () => {
  let waiting;
  let returned = false;
  const started = new Promise((resolve) => {
    waiting = resolve;
  });
  const speech = new SpeechClient(
    async () => {
      throw new Error('No chunks to load yet');
    },
    async (input) => input,
  );
  const producer = {
    [Symbol.asyncIterator]() {
      return this;
    },
    next() {
      waiting();
      return new Promise(() => {});
    },
    async return() {
      returned = true;
      return { done: true };
    },
  };
  const controller = new AbortController();
  const stream = speech.stream(producer, { abortSignal: controller.signal });
  const pending = assert.rejects(stream.next(), { name: 'AbortError' });
  await started;
  controller.abort();
  await pending;
  await speech.close();
  assert.equal(returned, true);
});

test('top-level helpers reuse defaults, close custom sessions, and recover after cancellation', async () => {
  let loaded = 0;
  let closed = 0;
  const api = shortcuts(
    () => {
      throw new Error('No text model needed');
    },
    () => {
      loaded++;
      return {
        async transcribe(audio) {
          if (audio === 'cancel') throw new NeedleError('CLOSED', 'closed');
          return { text: audio };
        },
        async close() {
          closed++;
        },
      };
    },
  );
  await api.transcribe('first');
  await api.transcribe('second', { language: 'en' });
  assert.equal(loaded, 1);
  await api.transcribe('custom', { weights: '/model.cact' });
  assert.equal(closed, 1);
  await assert.rejects(api.transcribe('cancel'), { code: 'CLOSED' });
  await api.transcribe('retry');
  assert.equal(loaded, 3);
  await api.close();
  await api.close();
  assert.equal(closed, 3);
});
