# Standalone API

See the [README](../README.md) for installation and quick starts, or the
[AI SDK guide](ai-sdk.md) for the provider integration.

## Sessions

`new Needle(options)` creates a reusable text model, loading it on the first call.
Import it from `cactus-needle` in Node.js or `cactus-needle/browser` in the browser.
The methods follow the Python SDK, with promises and camelCase options:

| Method | Result |
| --- | --- |
| `complete(text, { tools?, maxNewTokens?, abortSignal? }?)` | The upstream completion envelope, including `function_calls` |
| `run(text, { maxSteps?, strict?, abortSignal? }?)` | Executes registered tools and returns the final completion plus `results` |
| `extract(text, schema, { strict?, abortSignal? }?)` | A typed record, or `null` when the model withholds a prediction |
| `generate({ prompt, tools?, maxOutputTokens?, abortSignal? })` | `{ toolCalls, suppressedToolCalls, confidence, reasoning, raw }` |
| `embed(text, { abortSignal? }?)` | An independent `Float32Array`; 3072 dimensions with the pinned model |
| `reset()` | Clears conversation history, retaining the model and tools |
| `close()` | Terminates the worker and rejects outstanding calls; safe to call again |
| `[Symbol.asyncDispose]()` | Equivalent to `close()`, for `await using` callers |

Shared creation options:

| Option | Default | Purpose |
| --- | --- | --- |
| `tools` | No tools | Named tool definitions for generation |
| `system` | `''` | Environment facts supplied to the model |
| `stateless` | `false` | Clear history before each completion |
| `maxOutputTokens` | `512` | Default generation limit |
| `bufferSize` | `262144` | Maximum response size in bytes |

`maxNewTokens` is an alias for the default token limit;
`maxOutputTokens` takes precedence.
`complete()`, `run()`, and text `embed()` default to an empty input, as in Python.

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
[tool calling example](../README.md#tool-calling), or with a library that implements
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

Schemas must describe an object. JavaScript functions do not carry Python's
parameter annotations, so declare their inputs with `tool({ inputSchema })`.
Plain JSON Schema and compact/OpenAI-style schema arrays remain supported.
The engine supports a subset of JSON Schema. `run()` and `extract()` also call a
schema library's Standard Schema validator when available, including refinements.
With plain JSON Schema, validate any additional constraints in your callback.

## Running tools

`complete()` and `generate()` return predictions. `run()` executes the callbacks
you register and passes their JSON results back to the model until it responds
or reaches `maxSteps` (default 8). With `stateless: true`, history is cleared once
at the start of the run; the steps share their conversation.

```ts
import { Needle, tool } from 'cactus-needle';
import { z } from 'zod';

const lights = new Map<string, boolean>();
const agent = new Needle({
  tools: {
    set_lights: tool({
      description: 'Turn the lights in a room on or off.',
      inputSchema: z.object({ room: z.string(), on: z.boolean() }),
      execute({ room, on }) {
        lights.set(room, on);
        return { room, on };
      },
    }),
  },
});

try {
  const result = await agent.run('Turn on the kitchen lights');
  console.log(result.results); // [{ room: 'kitchen', on: true }]
} finally {
  await agent.close();
}
```

Suppressed calls are never executed. By default, `strict: true` also withholds
calls the engine flags as ungrounded or negated. Missing callbacks, validation
failures, and callback exceptions become error results for the next model step.
Callbacks receive `{ abortSignal }` as a second argument for cancelling their own work.

## Extraction

```ts
import * as needle from 'cactus-needle';
import { z } from 'zod';

const result = await needle.extract(
  'room: kitchen, on: true',
  z.object({ room: z.string(), on: z.boolean() }),
);
console.log(result); // { room: 'kitchen', on: true }
await needle.close();
```

`agent.extract(text, schema)` uses the existing worker. It clears conversation
history and temporarily supplies the extraction schema; later calls restore the
agent's default tools. `strict: true` raises `ExtractionValidationError` for native
grounding or negation flags. It does not reproduce Python's extra date/numeric
grounding heuristics or inject today's date. Supply relevant facts with `system`.

## Speech

The top-level `transcribe()` helper loads and retains a default Whistle session.
Use `new Whistle(options)` to own a session with custom weights or loading settings.

```js
import { Whistle } from 'cactus-needle';

const speech = new Whistle();
try {
  const result = await speech.transcribe('clip.wav', {
    language: 'en',
    keywords: ['Siobhán', 'Needle'],
    wordTimestamps: true,
  });
  console.log(result.text, result.words);
} finally {
  await speech.close();
}
```

Omit `language` for automatic detection. Supported languages are English (`en`),
German (`de`), French (`fr`), Spanish (`es`), Italian (`it`), Dutch (`nl`), and Polish (`pl`).
The result contains `text`, `language`, `durationInSeconds`, `timeToFirstTokenMs`,
`tokensPerSecond`, and optional `words` with `word`, `start`, `end`, and `probability`.
Word times are in seconds. Silence can return empty text and language.

Accepted inputs, up to 30 seconds per call:

| Input | Meaning |
| --- | --- |
| `Float32Array` | Mono 16 kHz samples in `[-1, 1]` |
| `{ samples: Float32Array, sampleRate }` | Mono audio at an explicit rate; resampled in the worker |
| `Uint8Array` / `ArrayBuffer` | Uncompressed WAV, downmixed and resampled in the worker |
| `string` / `URL` | Local path or `file:` URL in Node; fetched audio URL in browsers |
| `File` / `Blob` | Uncompressed WAV bytes |

PCM WAV supports 8/16/24/32-bit integers and 32/64-bit floats. Decode compressed
MP3, WebM, or Ogg with your platform's audio decoder first. The demo uses the
browser's `decodeAudioData()` for microphone recordings and sends PCM to Whistle.
Audio stays on the device during transcription.

`speech.embed(audio)` returns flattened encoder features, one row per 80 ms frame.
These are audio features, not Needle's text embedding vectors.

### Live transcription

`speech.stream(chunks)` and top-level `needle.stream(chunks)` accept an iterable
or async iterable of 16 kHz mono `Float32Array` chunks, usually about a second each.
The total stream length is unlimited; each chunk must fit the 30-second batch limit.

```js
const committed = [];
for await (const part of speech.stream(chunks, { language: 'en' })) {
  if (part.text) committed.push(part.text);
  console.log(committed.join(' '), part.pending);
}
```

Append committed `text` with a space; replace `pending` on every update.
Each update also has `words`, `language`, `received` (seconds), and `passMs`.
The iterator flushes a final update when input ends. Breaking the loop flushes
and resets the stream so the session can be reused. Use an abort signal or
`close()` to interrupt a stream waiting for its next audio chunk. Only one stream
can use a session at a time; finish it before calling `transcribe()` or `embed()`.

### Shared helpers

`transcribe()`, `stream()`, and `extract()` retain their default models across calls.
`await close()` releases those shared models. Passing custom loading settings
to a helper uses a scoped session, closed when the operation ends; use an instance
to keep custom weights loaded. No model is loaded merely by importing the package.

## Browser loading

`new Needle()` and `new Whistle()` load their worker, WASM, and pinned model on
first use. `await createNeedle()` and `await createWhistle()` load immediately
and resolve when inference is ready. Assets are verified before use.
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
| `weights` | — | Alias for `model` on the constructors and shared helpers |
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

Requires Node.js 22.18+. Constructors and top-level helpers download missing
default weights on first use. `weights` accepts a local path or `file:` URL
(`modelPath` is also accepted). Set `download: false` to require existing weights.

The immediate factories `createNeedle()` and `createWhistle()` never download
in Node. Supply `modelPath: '/path/needle3.cact'`
(or a `file:` URL), or populate the cache with `downloadModel({ cacheDir })` and
use the same `cacheDir` for creation. Missing files raise `MODEL_NOT_FOUND`.
Explicit paths accept compatible custom weights; default cached weights are
SHA-256 verified during loading.

`downloadModel({ model, cacheDir, signal, timeoutMs, onProgress })` returns the local
path. `timeoutMs` defaults to `300000`. `onProgress` receives `receivedBytes` and
`totalBytes`. Verified cache hits make no requests. Downloads stream into a
temporary file, verify size and SHA-256, and are renamed into place. Failed or
cancelled downloads leave no partial file. Corrupt cache entries raise
`INTEGRITY_ERROR`; remove the named file and download again.

`model` defaults to `'needle3'`; use `'whistle'` for speech:

```js
const modelPath = await downloadModel({ model: 'whistle' });
const speech = await createWhistle({ modelPath });
```

`getModelPath(cacheDir?, model?)` returns the path without reading or downloading. The
default root uses `XDG_CACHE_HOME`, Windows `LOCALAPPDATA`, or `~/.cache`, under
`cactus-needle-node/<revision>/<model>.cact`. `DEFAULT_MODEL` and `DEFAULT_SPEECH_MODEL`
expose the pinned URL, revision, size, and SHA-256 in both environments.

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

Aborting an active `complete()`, `generate()`, `run()`, `extract()`, `embed()`, or speech operation terminates the session and rejects its queued
work. Create a new session to continue. A signal already aborted before the
call rejects without closing the session. Browser setup cancellation also
terminates its worker. Abort reasons propagate to the caller.

`NeedleError` has `code` and `message`. Codes include `INVALID_ARGUMENT`,
`UNSUPPORTED_ENVIRONMENT`, `MODEL_NOT_FOUND`, `INVALID_MODEL`, `INTEGRITY_ERROR`,
`DOWNLOAD_FAILED`, `ENGINE_ERROR`, `INVALID_RESPONSE`, `WORKER_ERROR`, and `CLOSED`.
Engine errors preserve context-limit details. If response JSON exceeds
`bufferSize`, create a session with a larger buffer before retrying.
