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

test('failed lazy loads can retry, while failed eager initialization disposes the client', async (t) => {
  const reason = new NeedleError('MODEL_NOT_FOUND', 'Missing weights');
  for (const eager of [false, true]) {
    let loads = 0;
    const agent = new Agent(async () => {
      if (++loads === 1) throw reason;
      return { complete: async () => response(), close: async () => {} };
    }, {});
    t.after(() => agent.close());
    await assert.rejects(eager ? agent.ready() : agent.complete(), (error) => error === reason);
    if (eager) {
      await assert.rejects(agent.complete(), { code: 'CLOSED' });
      assert.equal(loads, 1);
    } else {
      assert.equal((await agent.complete()).success, true);
      assert.equal(loads, 2);
    }
  }
});

for (const method of ['complete', 'embed']) {
  test(`${method} cancels inference and queued work without loading on a pre-aborted call`, async () => {
    let entered;
    let loaded = 0;
    let closed = 0;
    const running = new Promise((resolve) => {
      entered = resolve;
    });
    const agent = new Agent(async () => {
      loaded++;
      return {
        [method]() {
          entered();
          return new Promise(() => {});
        },
        async close() {
          closed++;
        },
      };
    }, {});
    const reason = new Error('cancel inference');
    await assert.rejects(
      agent[method]('input', { abortSignal: AbortSignal.abort(reason) }),
      (error) => error === reason,
    );
    assert.equal(loaded, 0);
    const controller = new AbortController();
    const pending = assert.rejects(
      agent[method]('input', { abortSignal: controller.signal }),
      (error) => error === reason,
    );
    const queued = assert.rejects(agent.reset(), { code: 'CLOSED' });
    await running;
    controller.abort(reason);
    await Promise.all([pending, queued, agent.close()]);
    assert.equal(closed, 1);
  });
}

test('Python-style methods default to empty input', async (t) => {
  const inputs = [];
  const agent = new Agent(
    async () => ({
      async complete(input) {
        inputs.push(input);
        return response();
      },
      async embed(input) {
        inputs.push(input);
        return new Float32Array();
      },
      async close() {},
    }),
    {},
  );
  t.after(() => agent.close());
  await agent.complete();
  await agent.embed();
  await agent.run();
  assert.deepEqual(inputs, ['', '', '']);
});

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

test('closed speech sessions reject streams without reading or loading audio', async () => {
  const speech = new SpeechClient(
    async () => {
      assert.fail('Unexpected model load');
    },
    async () => {
      assert.fail('Unexpected audio read');
    },
  );
  await speech.close();
  const chunks = {
    [Symbol.asyncIterator]() {
      return this;
    },
    next() {
      assert.fail('A closed session must not wait for new audio');
    },
  };
  await assert.rejects(speech.stream(chunks).next(), { code: 'CLOSED' });
  await assert.rejects(speech.stream([]).next(), { code: 'CLOSED' });
  const reason = new Error('already cancelled');
  await assert.rejects(
    speech.transcribe('clip.wav', { abortSignal: AbortSignal.abort(reason) }),
    (error) => error === reason,
  );
  await assert.rejects(
    speech.embed('clip.wav', { abortSignal: AbortSignal.abort(reason) }),
    (error) => error === reason,
  );
});

test('audio producer cleanup cannot hide a cancellation reason', async () => {
  let entered;
  const reading = new Promise((resolve) => {
    entered = resolve;
  });
  const speech = new SpeechClient(
    async () => {
      assert.fail('Unexpected load');
    },
    async (input) => input,
  );
  const chunks = {
    [Symbol.asyncIterator]() {
      return this;
    },
    next() {
      entered();
      return new Promise(() => {});
    },
    return() {
      throw new Error('Audio source cleanup failed');
    },
  };
  const controller = new AbortController();
  const reason = new Error('cancelled by caller');
  const pending = assert.rejects(
    speech.stream(chunks, { abortSignal: controller.signal }).next(),
    (error) => error === reason,
  );
  await reading;
  controller.abort(reason);
  await pending;
  await speech.close();
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
  await api.transcribe('default options', { weights: undefined, cacheDir: undefined });
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

test('stream helpers share the batch model and dispose custom models on early return', async (t) => {
  const models = [];
  let fail = false;
  const api = shortcuts(
    () => assert.fail('No text model needed'),
    (options) => {
      const model = {
        options,
        closed: 0,
        finished: 0,
        async transcribe() {
          return { text: 'hello' };
        },
        async *stream() {
          try {
            if (fail) throw new NeedleError('WORKER_ERROR', 'Worker exited');
            yield chunk;
            yield chunk;
          } finally {
            this.finished++;
          }
        },
        async close() {
          this.closed++;
        },
      };
      models.push(model);
      return model;
    },
  );
  t.after(() => api.close());
  const unused = api.stream([], { weights: '/unused.cact' });
  await unused.return();
  const reason = new Error('Already cancelled');
  await assert.rejects(
    api.stream([], { abortSignal: AbortSignal.abort(reason) }).next(),
    (error) => error === reason,
  );
  assert.equal(models.length, 0);

  await api.transcribe('hello.wav');
  for await (const result of api.stream([])) {
    assert.equal(result, chunk);
    break;
  }
  assert.equal(models.length, 1);
  assert.equal(models[0].finished, 1);
  assert.equal(models[0].closed, 0);

  for await (const result of api.stream([], { weights: '/custom.cact' })) {
    assert.equal(result, chunk);
    break;
  }
  assert.equal(models.length, 2);
  assert.equal(models[1].finished, 1);
  assert.equal(models[1].closed, 1);
  assert.equal(models[0].closed, 0);

  fail = true;
  await assert.rejects(api.stream([]).next(), { code: 'WORKER_ERROR' });
  assert.equal(models[0].closed, 1);
  await api.transcribe('again.wav');
  assert.equal(models.length, 3);
  await api.close();
  assert.deepEqual(
    models.map((model) => model.closed),
    [1, 1, 1],
  );
});

test('a failing request from a closed helper model cannot discard its replacement', async (t) => {
  let rejectOld;
  const pending = new Promise((_resolve, reject) => {
    rejectOld = reject;
  });
  const models = [];
  const api = shortcuts(
    () => {
      const model = {
        closed: 0,
        async extract(input) {
          return input === 'pending' ? pending : { room: input };
        },
        async close() {
          this.closed++;
        },
      };
      models.push(model);
      return model;
    },
    () => assert.fail('No speech model needed'),
  );
  t.after(() => api.close());
  const schema = { type: 'object' };
  const failed = assert.rejects(api.extract('pending', schema), { code: 'CLOSED' });
  await api.close();
  assert.deepEqual(await api.extract('kitchen', schema), { room: 'kitchen' });
  rejectOld(new NeedleError('CLOSED', 'Old model closed'));
  await failed;
  await api.extract('bedroom', schema);
  assert.equal(models.length, 2);
  assert.deepEqual(
    models.map((model) => model.closed),
    [1, 0],
  );
});
