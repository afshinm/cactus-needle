import assert from 'node:assert/strict';
import { createReadStream, existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve, sep } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULT_MODEL, getModelPath } from '../../dist/index.js';
import { launchBrowser } from './launcher.mjs';

const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const modelPath = resolve(process.env.NEEDLE_MODEL_PATH || getModelPath(join(root, '.cache')));
assert.ok(
  existsSync(modelPath),
  'Run pnpm model:download or set NEEDLE_MODEL_PATH before browser tests.',
);
let browser, server, origin;
const requests = [];

before(async () => {
  server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    requests.push(url.pathname + url.search);
    if (url.pathname === '/') {
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end('<!doctype html><title>Needle browser integration</title>');
      return;
    }
    if (url.pathname === '/bad.cact') {
      response.end('not a model');
      return;
    }
    if (url.pathname === '/bad.wasm') {
      response.end('not WASM');
      return;
    }
    if (url.pathname === '/storage-blocked-worker.js') {
      response
        .writeHead(200, { 'content-type': 'text/javascript' })
        .end(
          'Object.defineProperty(globalThis, "caches", {get(){throw new DOMException("Storage denied", "SecurityError")}});\n' +
            (await readFile(join(root, 'dist/browser/worker.js'), 'utf8')),
        );
      return;
    }
    if (url.pathname === '/slow.cact') {
      const timeout = setTimeout(() => response.end('too late'), 60_000);
      response.on('close', () => clearTimeout(timeout));
      return;
    }
    const path = url.pathname === '/model.cact' ? modelPath : resolve(root, `.${url.pathname}`);
    if (path !== modelPath && !path.startsWith(root + sep)) {
      response.writeHead(403).end();
      return;
    }
    try {
      const info = await stat(path);
      if (!info.isFile()) throw new Error('Not a file.');
      response.writeHead(200, {
        'content-length': info.size,
        'content-type': path.endsWith('.js')
          ? 'text/javascript'
          : path.endsWith('.wasm')
            ? 'application/wasm'
            : 'application/octet-stream',
      });
      createReadStream(path).pipe(response);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((ready, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', ready);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await launchBrowser();
  console.log(`Testing browser inference in Chromium ${browser.version()}.`);
});
after(async () => {
  await browser?.close();
  server?.closeAllConnections();
  if (server) await new Promise((done) => server.close(done));
});

async function pageFor(t) {
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  await page.goto(origin);
  await page.evaluate(async () => {
    window.sdk = await import('/dist/browser/index.js');
    window.tools = {
      set_lights: sdk.tool({
        description: 'Turn the lights in a room on or off.',
        inputSchema: {
          type: 'object',
          properties: { room: { type: 'string' }, on: { type: 'boolean' } },
          required: ['room', 'on'],
        },
      }),
    };
    window.options = { model: '/model.cact', tools: window.tools, stateless: true };
  });
  return page;
}

test('real browser WASM inference stays local and leaves the UI thread responsive', {
  timeout: 30_000,
}, async (t) => {
  const page = await pageFor(t);
  const setup = await page.evaluate(async (sha256) => {
    window.progress = [];
    const start = performance.now();
    window.needle = await sdk.createNeedle({
      ...options,
      modelSha256: sha256,
      onDownloadProgress: (value) => progress.push(value),
    });
    return { elapsed: performance.now() - start, progress, isolated: crossOriginIsolated };
  }, DEFAULT_MODEL.sha256);
  assert.equal(setup.isolated, false, 'SharedArrayBuffer/COOP/COEP must not be required.');
  assert.equal(setup.progress.at(-1).loaded, DEFAULT_MODEL.size);
  assert.equal(setup.progress.at(-1).percentage, 100);
  const observed = requests.length;
  await page.context().setOffline(true);
  const result = await page.evaluate(async () => {
    let ticks = 0;
    const timer = setInterval(() => ticks++, 2);
    const start = performance.now();
    const generated = await needle.generate({ prompt: 'Turn on the kitchen lights' });
    const elapsed = performance.now() - start;
    clearInterval(timer);
    const vector = await needle.embed('kitchen lights');
    const snapshot = Array.from(vector);
    await needle.embed('Paris');
    await needle.close();
    return {
      generated,
      ticks,
      elapsed,
      vector: Array.from(vector),
      snapshot,
      dimension: vector.length,
    };
  });
  assert.deepEqual(result.generated.toolCalls, [
    { toolName: 'set_lights', input: { room: 'kitchen', on: true } },
  ]);
  assert.ok(result.generated.confidence > 0 && result.generated.confidence <= 1);
  assert.ok(result.ticks > 0);
  assert.equal(result.dimension, 3072);
  assert.ok(result.vector.every(Number.isFinite));
  assert.deepEqual(result.vector, result.snapshot);
  assert.equal(requests.length, observed, 'No server requests are made during inference.');
  console.log(
    `Browser setup ${setup.elapsed.toFixed(0)} ms; generation ${result.elapsed.toFixed(0)} ms (local test machine).`,
  );
});

test('a new worker loads cached model and WASM without downloading assets', {
  timeout: 30_000,
}, async (t) => {
  const page = await pageFor(t);
  await page.evaluate(async () => {
    const needle = await sdk.createNeedle(options);
    await needle.close();
  });
  const observed = requests.length;
  // Worker scripts must still load. Block model/WASM network requests after the cache is populated.
  await page.context().route(/model\.cact|needle\.wasm/, (route) => route.abort());
  const result = await page.evaluate(async () => {
    const progress = [];
    const needle = await sdk.createNeedle({
      ...options,
      offline: true,
      onDownloadProgress: (value) => progress.push(value),
    });
    try {
      return {
        generated: await needle.generate({ prompt: 'Turn off the bedroom lights' }),
        progress,
      };
    } finally {
      await needle.close();
    }
  });
  assert.deepEqual(result.generated.toolCalls[0].input, { room: 'bedroom', on: false });
  assert.deepEqual(result.progress, [
    { loaded: DEFAULT_MODEL.size, total: DEFAULT_MODEL.size, percentage: 100 },
  ]);
  assert.ok(
    requests.slice(observed).every((url) => !url.includes('.cact') && !url.includes('.wasm')),
  );
});

test('bytes retain caller ownership and sessions remain isolated', {
  timeout: 30_000,
}, async (t) => {
  const page = await pageFor(t);
  const result = await page.evaluate(async () => {
    const bytes = new Uint8Array(await (await fetch('/model.cact')).arrayBuffer());
    const a = await sdk.createNeedle({ ...options, model: bytes, cache: false });
    const b = await sdk.createNeedle({
      ...options,
      model: bytes.buffer,
      tools: {
        set_thermostat: sdk.tool({
          description: 'Set the thermostat temperature in degrees Celsius.',
          inputSchema: {
            type: 'object',
            properties: { temperature: { type: 'integer' } },
            required: ['temperature'],
          },
        }),
      },
    });
    try {
      const [lights, thermostat] = await Promise.all([
        a.generate({ prompt: 'Turn on the kitchen lights' }),
        b.generate({ prompt: 'Set the thermostat to 21 degrees' }),
      ]);
      await a.close();
      await b.reset();
      return {
        size: bytes.length,
        tag: new DataView(bytes.buffer).getUint32(0, true),
        lights,
        thermostat,
        next: await b.generate({ prompt: 'Set the thermostat to 19 degrees' }),
      };
    } finally {
      await Promise.all([a.close(), b.close()]);
    }
  });
  assert.equal(result.size, DEFAULT_MODEL.size);
  assert.equal(result.tag, 0x05e12a84);
  assert.equal(result.lights.toolCalls[0].toolName, 'set_lights');
  assert.deepEqual(result.thermostat.toolCalls[0].input, { temperature: 21 });
  assert.deepEqual(result.next.toolCalls[0].input, { temperature: 19 });
});

test('missing, invalid and corrupt assets fail clearly; corrupt cache entries are evicted', {
  timeout: 30_000,
}, async (t) => {
  const page = await pageFor(t);
  const result = await page.evaluate(async (sha256) => {
    const code = async (extra) => {
      try {
        const session = await sdk.createNeedle({ ...options, ...extra });
        await session.close();
        return 'unexpected success';
      } catch (error) {
        return error.code;
      }
    };
    const failures = [
      await code({ offline: true }),
      await code({ model: '/bad.cact' }),
      await code({ model: '/missing.cact' }),
      await code({ wasmUrl: '/bad.wasm' }),
      await code({ modelSha256: '0'.repeat(64) }),
    ];
    const session = await sdk.createNeedle({ ...options, modelSha256: sha256 });
    await session.close();
    const cache = await caches.open((await caches.keys())[0]);
    const key = (await cache.keys()).find((request) =>
      request.url.includes(`__needle_sha256=${sha256}`),
    );
    await cache.put(key, new Response('corrupted'));
    failures.push(await code({ modelSha256: sha256, offline: true }));
    failures.push(await code({ modelSha256: sha256, offline: true }));
    return failures;
  }, DEFAULT_MODEL.sha256);
  assert.deepEqual(result, [
    'MODEL_NOT_FOUND',
    'INVALID_MODEL',
    'DOWNLOAD_FAILED',
    'INTEGRITY_ERROR',
    'INTEGRITY_ERROR',
    'INTEGRITY_ERROR',
    'MODEL_NOT_FOUND',
  ]);
});

test('setup cancellation, generation cancellation and close reject outstanding work', {
  timeout: 30_000,
}, async (t) => {
  const page = await pageFor(t);
  const result = await page.evaluate(async () => {
    const controller = new AbortController();
    const loading = sdk
      .createNeedle({ ...options, model: '/slow.cact', abortSignal: controller.signal })
      .catch((error) => error.name);
    setTimeout(() => controller.abort(), 50);
    const setup = await loading;
    const needle = await sdk.createNeedle(options);
    const active = new AbortController();
    const generation = needle
      .generate({ prompt: 'Turn on the kitchen lights', abortSignal: active.signal })
      .catch((error) => error.name);
    const queued = needle.embed('queued').catch((error) => error.code);
    active.abort();
    await needle.close();
    await needle.close();
    return [
      setup,
      await generation,
      await queued,
      await needle.reset().catch((error) => error.code),
    ];
  });
  assert.deepEqual(result, ['AbortError', 'AbortError', 'CLOSED', 'CLOSED']);
});

test('cache disabled keeps verified assets out of persistent storage', {
  timeout: 30_000,
}, async (t) => {
  const page = await pageFor(t);
  const keys = await page.evaluate(async () => {
    const needle = await sdk.createNeedle({ ...options, cache: false });
    await needle.close();
    return caches.keys();
  });
  assert.deepEqual(keys, []);
});

test('denied CacheStorage does not prevent inference with custom asset URLs', {
  timeout: 30_000,
}, async (t) => {
  const page = await pageFor(t);
  const result = await page.evaluate(async () => {
    const needle = await sdk.createNeedle({
      ...options,
      workerUrl: '/storage-blocked-worker.js',
      wasmUrl: '/dist/browser/needle.wasm',
    });
    try {
      return await needle.generate({ prompt: 'Turn on the kitchen lights' });
    } finally {
      await needle.close();
    }
  });
  assert.deepEqual(result.toolCalls, [
    { toolName: 'set_lights', input: { room: 'kitchen', on: true } },
  ]);
});
