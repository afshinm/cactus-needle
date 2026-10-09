import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UnsupportedFunctionalityError } from '@ai-sdk/provider';
import { transcribe } from 'ai';
import { experimental_transcribe as transcribeV6 } from 'ai-v6';
import { NeedleTranscriptionModel } from '../dist/ai-sdk/transcription-model.js';
import { Engine } from '../dist/runtime/engine.js';
import { wav } from './fixtures/audio.mjs';

const transcript = {
  text: 'Kitchen lights on.',
  language: 'en',
  durationInSeconds: 1,
  words: [{ word: 'Kitchen', start: 0.1, end: 0.4, probability: 0.98 }],
  timeToFirstTokenMs: 15,
  tokensPerSecond: 70,
};

function engine() {
  const allocations = new Set();
  const calls = [];
  const heap = new Uint8Array(1 << 20);
  let next = 8;
  let response = {
    text: transcript.text,
    language: 'en',
    ttft_ms: 15,
    decode_tps: 70,
    words: transcript.words,
  };
  let code = 4;
  const module = {
    HEAPU8: heap,
    _malloc(size) {
      const pointer = next;
      next += Math.ceil(size / 8) * 8;
      allocations.add(pointer);
      return pointer;
    },
    _free(pointer) {
      assert.ok(allocations.delete(pointer));
    },
    _needle_load: () => 0,
    _needle_models: () => 2,
    _needle_last_error: () => 0,
    UTF8ToString: (pointer) =>
      new TextDecoder().decode(heap.subarray(pointer, heap.indexOf(0, pointer))),
    _needle_transcribe(pcm, length, language, keywords, timestamps, output) {
      calls.push({
        samples: [...new Float32Array(heap.buffer, pcm, length)],
        language: language ? module.UTF8ToString(language) : null,
        keywords: keywords ? module.UTF8ToString(keywords) : null,
        timestamps,
      });
      heap.set(new TextEncoder().encode(`${JSON.stringify(response)}\0`), output);
      return code;
    },
  };
  const header = Buffer.alloc(240);
  header.writeUInt32LE(0x05e12a84);
  header.writeUInt32LE(1, 4);
  const instance = Engine.create(module, { modelKind: 'whistle', bufferSize: 4096 }, header);
  return {
    instance,
    calls,
    allocations,
    reply(value, status = 4) {
      response = value;
      code = status;
    },
  };
}

test('speech ABI preserves PCM slices, optional pointers, UTF-8 keywords, and word timings', () => {
  const { instance, calls, allocations } = engine();
  const samples = new Float32Array([99, 0.25, -0.5, 99]).subarray(1, 3);
  const retained = new Set(allocations);
  assert.deepEqual(
    instance.transcribe(samples, {
      language: 'en',
      keywords: ['Siobhán', 'Needle'],
      wordTimestamps: true,
    }),
    {
      ...transcript,
      durationInSeconds: 2 / 16_000,
    },
  );
  assert.deepEqual(calls[0], {
    samples: [0.25, -0.5],
    language: 'en',
    keywords: 'Siobhán\nNeedle',
    timestamps: 1,
  });
  instance.transcribe(samples, {});
  assert.deepEqual(calls[1], {
    samples: [0.25, -0.5],
    language: null,
    keywords: null,
    timestamps: 0,
  });
  assert.deepEqual(
    allocations,
    retained,
    'Temporary allocations must be released after each call.',
  );
});

test('malformed native transcripts and native failures release temporary memory', () => {
  const { instance, allocations, reply } = engine();
  const retained = new Set(allocations);
  for (const value of [
    null,
    {},
    {
      text: 'bad',
      language: 'en',
      ttft_ms: 0,
      decode_tps: 0,
      words: [{ word: 'bad', start: 2, end: 1, probability: 1 }],
    },
  ]) {
    reply(value);
    assert.throws(() => instance.transcribe(new Float32Array(10), {}), {
      code: 'INVALID_RESPONSE',
    });
    assert.deepEqual(allocations, retained);
  }
  reply({}, -1);
  assert.throws(() => instance.transcribe(new Float32Array(10), {}), { code: 'ENGINE_ERROR' });
  assert.deepEqual(allocations, retained);
});

for (const [version, sdk] of [
  ['7', transcribe],
  ['6', transcribeV6],
]) {
  test(`AI SDK ${version} consumes Whistle transcripts and closes each request`, async () => {
    let closed = 0;
    const audio = wav(new Float32Array(16_000));
    const model = new NeedleTranscriptionModel('whistle', async () => ({
      async transcribe(input, options) {
        assert.deepEqual(Buffer.from(input), audio);
        assert.deepEqual(options, { language: 'en', keywords: ['Kitchen'], wordTimestamps: true });
        return transcript;
      },
      async close() {
        closed++;
      },
    }));
    const result = await sdk({
      model,
      audio,
      maxRetries: 0,
      providerOptions: { needle: { language: 'en', keywords: ['Kitchen'] } },
    });
    assert.equal(result.text, transcript.text);
    assert.equal(result.language, 'en');
    assert.equal(result.durationInSeconds, 1);
    assert.deepEqual(result.segments, [{ text: 'Kitchen', startSecond: 0.1, endSecond: 0.4 }]);
    assert.equal(closed, 1);
  });
}

test('transcription adapter validates formats, decodes base64, and cleans up on errors', async () => {
  let loaded = 0;
  let closed = 0;
  const audio = wav([0, 0]);
  const model = new NeedleTranscriptionModel('whistle', async () => {
    loaded++;
    return {
      async transcribe(input) {
        assert.deepEqual(Buffer.from(input), audio);
        throw new Error('decode failed');
      },
      async close() {
        closed++;
      },
    };
  });
  await assert.rejects(
    model.doGenerate({ audio, mediaType: 'audio/mpeg' }),
    UnsupportedFunctionalityError.isInstance,
  );
  await assert.rejects(model.doGenerate({ audio: 'bad base64!', mediaType: 'audio/wav' }), {
    code: 'INVALID_ARGUMENT',
  });
  await assert.rejects(
    model.doGenerate({
      audio,
      mediaType: 'audio/wav',
      providerOptions: { needle: { language: 'xx' } },
    }),
    { code: 'INVALID_ARGUMENT' },
  );
  await assert.rejects(
    model.doGenerate({ audio, mediaType: 'audio/wav', abortSignal: AbortSignal.abort() }),
    { name: 'AbortError' },
  );
  assert.equal(loaded, 0);
  await assert.rejects(
    model.doGenerate({ audio: audio.toString('base64'), mediaType: 'audio/wav' }),
    /decode failed/,
  );
  assert.equal(loaded, 1);
  assert.equal(closed, 1);
});
