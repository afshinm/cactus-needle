# Standalone API

See the [README](../README.md) for installation and quick starts, or the
[AI SDK guide](ai-sdk.md) for the provider integration.

## Sessions

`await createNeedle(options)` loads the model into a worker and returns a session.
Import it from `cactus-needle` in Node.js or `cactus-needle/browser` in the browser.
Both entries expose the same session methods:

| Method | Result |
| --- | --- |
| `generate({ prompt, tools?, maxOutputTokens?, abortSignal? })` | `{ toolCalls, suppressedToolCalls, confidence, reasoning, raw }` |
| `embed(text)` | An independent `Float32Array`; 3072 dimensions with the pinned model |
| `reset()` | Clears conversation history, retaining the model and tools |
| `close()` | Terminates the worker and rejects outstanding calls; safe to call again |
| `[Symbol.asyncDispose]()` | Equivalent to `close()`, for `await using` callers |
| `complete(text, { tools?, maxNewTokens? }?)` | The parsed upstream completion envelope; retained for compatibility |

Shared creation options:

| Option | Default | Purpose |
| --- | --- | --- |
| `tools` | No tools | Named tool definitions for generation |
| `system` | `''` | Environment facts supplied to the model |
| `stateless` | `false` | Clear history before each completion |
| `maxOutputTokens` | `512` | Default generation limit |
| `bufferSize` | `262144` | Maximum response size in bytes |

`maxNewTokens` remains an alias for the default token limit;
`maxOutputTokens` takes precedence.

Calls on a session run in arrival order. Each session has its own worker and
WASM memory. Keep the session while your application needs the model, including
when switching screens. Use `stateless: true` or `reset()` for independent
requests. Call `close()` when finished to release memory. Idle Node workers do
not keep the process alive.

Pass `tools` to `generate()` to replace the creation-time defaults for that
request. The result types follow the supplied tools. Omitting `tools` uses the
creation-time defaults again; an empty object or array enables no tools.
Changing schemas clears conversation history but retains the loaded model and
worker. Unchanged schemas reuse the existing configuration. System facts stay
fixed for the session.

```js
const needle = await createNeedle({ stateless: true });
try {
  await needle.generate({ prompt: 'Set the tempo to 128', tools: studioTools });
  await needle.generate({ prompt: 'Turn on the kitchen lights', tools: lightTools });
} finally {
  await needle.close();
}
```

## Tool schemas

Use the standalone `tool()` helper with plain JSON Schema, as shown in the
[browser quick start](../README.md#browser), or with a library that implements
[Standard JSON Schema](https://standardschema.dev/json-schema). No schema library
is required. For example, Zod 4.2+ preserves inferred input types:

```ts
import { createNeedle, tool } from 'cactus-needle/browser';
import { z } from 'zod';

const needle = await createNeedle({
  tools: {
    set_lights: tool({
      description: 'Turn the lights in a room on or off.',
      inputSchema: z.object({ room: z.string(), on: z.boolean() }),
    }),
  },
});

try {
  const { toolCalls } = await needle.generate({ prompt: 'Turn on the kitchen lights' });
  for (const call of toolCalls) {
    console.log(call.toolName, call.input.room, call.input.on);
    // toolName: 'set_lights'; room: string; on: boolean
  }
} finally {
  await needle.close();
}
```

Tool names come from object keys. With multiple tools, checking `toolName`
narrows the input type. Basic literal JSON Schemas also infer inputs, including
required and optional properties, arrays, and enums. Unsupported type inference
falls back to `unknown`.

Schemas must describe an object. The engine supports a subset of JSON Schema;
keywords and refinements that its grammar cannot represent or enforce do not
provide additional runtime validation. Validate inputs in your application if
you need stricter checks. For structured extraction, define a single tool with
the desired record schema.

The standalone client returns predictions and never executes tools. It does not
include the Python SDK's `extract()` validator or automatic `run()` loop.
Legacy compact and OpenAI-style tool schema arrays remain supported.

## Browser loading

The first `createNeedle()` loads the packaged worker and WASM, downloads the
pinned model, and verifies the assets. It resolves when inference is ready.
Inference uses CPU WebAssembly in a module worker; WebGPU, SharedArrayBuffer,
and COOP/COEP headers are not required.

Use HTTPS or localhost. Chromium and Vite development and production builds
have been tested. Other browsers and bundlers have not been validated.

```js
import { createNeedle } from 'cactus-needle/browser';

const controller = new AbortController();
const needle = await createNeedle({
  model: '/models/needle3.cact', // Omit to download from Hugging Face.
  onDownloadProgress({ loaded, percentage }) {
    console.log(percentage ?? loaded);
  },
  abortSignal: controller.signal,
});

try {
  console.log(await needle.embed('kitchen lights'));
} finally {
  await needle.close();
}
```

| Option | Default | Purpose |
| --- | --- | --- |
| `model` | Pinned model URL | URL, page-relative path, `ArrayBuffer`, or `Uint8Array` |
| `cache` | `true` | Persist verified model and WASM bytes with CacheStorage when available |
| `offline` | `false` | Read model/WASM from cache only; a missing asset rejects |
| `modelSha256` | Pinned hash for the default URL | Optional SHA-256 for self-hosted or custom weights |
| `onDownloadProgress` | — | Reports `loaded`, `total`, and `percentage` when known; cache hits report 100% |
| `abortSignal` | — | Cancel setup and terminate the loading worker |
| `workerUrl`, `wasmUrl` | Packaged assets | Override asset locations for your deployment |

Compatible Needle 3 `.cact` fine-tunes are accepted. Supplied byte buffers are
copied before transfer, so your buffer remains usable. Custom models are
validated as containers; supply `modelSha256` for checksum verification. The
default model and bundled WASM always require their pinned checksums.

### Caching and offline use

Later sessions reuse verified cached model and WASM bytes, but each new session
still initializes a worker and loads its own copy into memory. Reuse the same
session to avoid that cost. A loaded session can run inference with the network
disabled.

`offline: true` prevents model and WASM downloads. Your application and worker
JavaScript must still be available, for example through your application's
service worker. CacheStorage requires a secure context and may be unavailable
or evicted. Ordinary setup can continue without persistence when storage is
denied or full. Corrupt cached assets are rejected and evicted; a subsequent
online setup can fetch a fresh copy.

### Bundlers and asset hosting

Vite resolves the worker and WASM automatically. If your bundler does not
process worker URLs in dependencies, copy the exported
`cactus-needle/browser/worker.js` and `cactus-needle/browser/needle.wasm` assets
to your public directory, then pass `workerUrl` and `wasmUrl`.

Serve the worker from your application's origin. Cross-origin model and WASM
servers must allow CORS. Your Content Security Policy must allow the worker,
WebAssembly compilation, and asset download origins.

The root export has a `browser` condition. The explicit `/browser` entry also
works without configuring TypeScript conditions. Importing it during SSR is
safe; call `createNeedle()` on the client.

## Node.js loading

Requires Node.js 22.18+. See the [Node quick start](../README.md#nodejs) for a
complete example.

`createNeedle()` never downloads in Node. Supply `modelPath: '/path/needle3.cact'`
(or a `file:` URL), or populate the cache with `downloadModel({ cacheDir })` and
use the same `cacheDir` for creation. Missing files raise `MODEL_NOT_FOUND`.
Explicit paths accept compatible custom weights; default cached weights are
SHA-256 verified during loading.

`downloadModel({ cacheDir, signal, timeoutMs, onProgress })` returns the local
path. `timeoutMs` defaults to `300000`. `onProgress` receives `receivedBytes` and
`totalBytes`. Verified cache hits make no requests. Downloads stream into a
temporary file, verify size and SHA-256, and are renamed into place. Failed or
cancelled downloads leave no partial file. Corrupt cache entries raise
`INTEGRITY_ERROR`; remove the named file and download again.

`getModelPath(cacheDir?)` returns the path without reading or downloading. The
default root uses `XDG_CACHE_HOME`, Windows `LOCALAPPDATA`, or `~/.cache`, under
`cactus-needle-node/<revision>/needle3.cact`. `DEFAULT_MODEL` exposes the pinned
URL, revision, size, and SHA-256 in both environments.

CommonJS is supported on the required Node versions:

```js
const { createNeedle, downloadModel, tool } = require('cactus-needle');
```

## Results and errors

`generate()` returns predictions. An empty `toolCalls` array is valid when no
tool applies. Suppressed calls are reported in `suppressedToolCalls`.
`raw` retains the engine's fields, including `validation`, `success`,
`function_calls`, `suppressed_calls`, and timing. A failed engine result rejects
`generate()`; `complete()` exposes the original success/error fields.

`confidence` is `null` when weights have no trained confidence head. Unavailable
or negative `peak_ram_mb` measurements become `null`. A schema constrains the
output shape; use confidence and grounding validation to assess predictions.

Aborting an active `generate()` terminates the session and rejects its queued
work. Create a new session to continue. A signal already aborted before the
call rejects without closing the session. Browser setup cancellation also
terminates its worker. Abort reasons propagate to the caller.

`NeedleError` has `code` and `message`. Codes include `INVALID_ARGUMENT`,
`UNSUPPORTED_ENVIRONMENT`, `MODEL_NOT_FOUND`, `INVALID_MODEL`, `INTEGRITY_ERROR`,
`DOWNLOAD_FAILED`, `ENGINE_ERROR`, `INVALID_RESPONSE`, `WORKER_ERROR`, and `CLOSED`.
Engine errors preserve context-limit details. If response JSON exceeds
`bufferSize`, create a session with a larger buffer before retrying.
