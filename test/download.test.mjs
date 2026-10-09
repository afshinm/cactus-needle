import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { DEFAULT_MODEL, downloadModel, getModelPath } from '../dist/index.js';

async function cache(t) {
  const cacheDir = await mkdtemp(join(tmpdir(), 'needle-download-'));
  t.after(() => rm(cacheDir, { recursive: true, force: true }));
  return cacheDir;
}

test('HTTP errors do not leave a model or partial file', async (t) => {
  const cacheDir = await cache(t);
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.equal(url, DEFAULT_MODEL.url);
    assert.ok(url.includes(DEFAULT_MODEL.revision));
    return new Response('unavailable', { status: 503 });
  });
  await assert.rejects(downloadModel({ cacheDir }), { code: 'DOWNLOAD_FAILED' });
  assert.deepEqual(await readdir(dirname(getModelPath(cacheDir))), []);
});

test('truncated downloads are rejected and cleaned up', async (t) => {
  const cacheDir = await cache(t);
  t.mock.method(globalThis, 'fetch', async () => new Response('truncated'));
  await assert.rejects(downloadModel({ cacheDir }), { code: 'INTEGRITY_ERROR' });
  assert.deepEqual(await readdir(dirname(getModelPath(cacheDir))), []);
});

test('same-size corrupt downloads fail checksum verification', async (t) => {
  const cacheDir = await cache(t);
  t.mock.method(globalThis, 'fetch', async () => new Response(new Uint8Array(DEFAULT_MODEL.size)));
  await assert.rejects(downloadModel({ cacheDir }), { code: 'INTEGRITY_ERROR' });
  assert.deepEqual(await readdir(dirname(getModelPath(cacheDir))), []);
});

test('download cancellation cleans up incomplete files', async (t) => {
  const cacheDir = await cache(t);
  const controller = new AbortController();
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        new ReadableStream({
          start(stream) {
            stream.enqueue(new Uint8Array(1024));
          },
        }),
      ),
  );
  const reason = new Error('cancelled by caller');
  await assert.rejects(
    downloadModel({
      cacheDir,
      signal: controller.signal,
      onProgress() {
        controller.abort(reason);
      },
    }),
    (error) => error === reason,
  );
  assert.deepEqual(await readdir(dirname(getModelPath(cacheDir))), []);
});

test('already-aborted downloads never access the network', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', () => {
    throw new Error('unexpected network');
  });
  await assert.rejects(downloadModel({ signal: AbortSignal.abort() }), { name: 'AbortError' });
  assert.equal(fetch.mock.callCount(), 0);
});
