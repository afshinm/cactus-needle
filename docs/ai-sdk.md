# Vercel AI SDK provider

Needle is available as a standard AI SDK provider and as a standalone client.
Both use the same local WebAssembly engine. No hosted inference API is involved.

The provider implements the V3 language, embedding, and transcription contracts
accepted by AI SDK 6 and 7. Language and embedding inference have been tested with
`ai@6.0.302` and `ai@7.0.136` in Node and Chromium, including Vite development and
production builds. The SDK contracts and conversion are
documented in the [provider guide](https://ai-sdk.dev/providers/community-providers/custom-providers)
and [AI SDK source](https://github.com/vercel/ai/blob/main/packages/ai/src/model/as-language-model-v4.ts).

## Setup

Install `ai` and a schema library such as `zod` alongside `cactus-needle`.
The `ai` package is an optional peer. Standalone users do not need it; the
package includes the small provider contract dependency for this binding.

For browsers:

```ts
import { generateText } from 'ai';
import { z } from 'zod';
import { createNeedle } from 'cactus-needle/ai-sdk/browser';

const needle = createNeedle({
  // Omit model to use the pinned Hugging Face download.
  model: '/models/needle3.cact',
  onDownloadProgress: ({ percentage }) => console.log(percentage),
});

const result = await generateText({
  model: needle('needle3'),
  tools: {
    set_lights: {
      description: 'Turn the lights in a room on or off.',
      inputSchema: z.object({ room: z.string(), on: z.boolean() }),
    },
  },
  prompt: 'Turn on the kitchen lights',
});

console.log(result.toolCalls);
console.log(result.providerMetadata?.needle?.confidence);
```

`createNeedle()` accepts browser loading options such as `model`,
`modelSha256`, `cache`, `offline`, `onDownloadProgress`, `workerUrl`, and `wasmUrl`.
Asset loading starts with the first SDK request. HTTPS or localhost is required.
`offline: true` requires cached model/WASM bytes; your application and worker
scripts must also be available. See the [browser setup guide](usage.md#browser-loading).

Import `NeedleProviderSettings` from the same entry to type provider settings.
The named `needle`/`createNeedle` exports follow the AI SDK provider convention,
as used by [Mistral](https://github.com/vercel/ai/blob/main/packages/mistral/src/index.ts)
and [Anthropic](https://github.com/vercel/ai/blob/main/packages/anthropic/src/index.ts).
`createNeedleProvider` remains an alias of `createNeedle`. The old type names
`NeedleProviderOptions` (Node) and `BrowserNeedleProviderOptions` (browser) remain
aliases of their entry's `NeedleProviderSettings`.

The preconfigured `needle` provider is equivalent to `createNeedle()`.
`needle()` and `needle('needle3')` select the same model. The `/ai-sdk` entry also
has a browser export condition, so bundlers can select it automatically. The
explicit `/ai-sdk/browser` entry is useful in shared/SSR projects; imports are
safe during SSR, but browser inference must run on the client.

For Node, provision the weights explicitly and use the Node entry:

```js
import { downloadModel } from 'cactus-needle';
import { createNeedle } from 'cactus-needle/ai-sdk';

const modelPath = await downloadModel();
const needle = createNeedle({ modelPath });
// Use needle('needle3') with the same AI SDK calls shown above.
```

In Node, the preconfigured `needle` provider reads the ordinary model cache; SDK inference
never downloads Node weights. `cacheDir`, `modelPath`, `system`, and default token
limits can be configured on the provider. Custom compatible `.cact` weights
still use the model ID `needle3`.

## SDK operations

| Interface | Supported behavior |
| --- | --- |
| `generateText({ model, tools, prompt })` | Native SDK tool schemas, validation and execution callbacks |
| `streamText({ model, tools, prompt })` | Buffered reasoning/tool/finish events |
| `generateText` / `streamText` with `Output.object({ schema })` | Structured extraction into an object |
| `embed({ model: needle.embeddingModel(), value })` | One local embedding |
| `embedMany({ model: needle.embeddingModel(), values })` | Embeddings in input order; one worker for the batch |
| `transcribe({ model: needle.transcriptionModel(), audio })` | Local Whistle transcription of uncompressed WAV |
| `createProviderRegistry({ needle })` | Language/embedding models as `needle:needle3`; transcription as `needle:whistle` |

```ts
import { embed, generateText, Output } from 'ai';
import { z } from 'zod';

const { embedding } = await embed({
  model: needle.embeddingModel('needle3'),
  value: 'kitchen lights',
});

const { output } = await generateText({
  model: needle('needle3'),
  output: Output.object({ schema: z.object({ room: z.string(), on: z.boolean() }) }),
  prompt: 'room: kitchen, on: true',
});
// output: { room: 'kitchen', on: true }
```

Use AI SDK tool definitions, including its `tool()` helper if desired. The
standalone package's `tool()` helper belongs to the standalone client. When an
SDK tool includes `execute`, AI SDK runs it after accepting and validating the
model's tool call. Tool callbacks and any SDK telemetry are controlled by your
application.

## Transcription

```js
import { readFile } from 'node:fs/promises';
import { transcribe } from 'ai';
import { downloadModel } from 'cactus-needle';
import { createNeedle } from 'cactus-needle/ai-sdk';

const modelPath = await downloadModel({ model: 'whistle' });
const needle = createNeedle({ speech: { modelPath } });
const result = await transcribe({
  model: needle.transcriptionModel('whistle'),
  audio: await readFile('clip.wav'),
  providerOptions: {
    needle: { language: 'en', keywords: ['Siobhán'], wordTimestamps: true },
  },
});
console.log(result.text, result.segments);
```

With AI SDK 6, import `experimental_transcribe as transcribe` from `ai`.
AI SDK 6 throws `NoTranscriptGeneratedError` when Whistle returns an empty
transcript for silence; AI SDK 7 and the standalone API return empty text.
The result includes word segments, detected language, audio duration, and
`providerMetadata.needle` timing fields. Word timestamps are enabled by default
for SDK transcription. Omit `language` to detect it automatically.

In browsers, use `cactus-needle/ai-sdk/browser` and supply WAV bytes from your file
input. Default Whistle weights download and cache on first use. Override them with
`createNeedle({ speech: { model: '/models/whistle.cact' } })`. Text weights passed
at the provider's top level never apply to speech; shared cache and WASM settings do.

The provider accepts uncompressed WAV, up to 30 seconds, in the seven
[supported languages](usage.md#speech). Convert compressed recordings to WAV
before calling the SDK, or use the standalone API with decoded PCM samples.
Live chunk transcription is available through standalone `Whistle.stream()`;
this provider's V3 contract exposes batch transcription only.

## Lifecycle and supported inputs

Each SDK request creates and closes its own inference worker. Callers do not
need `close()`. Concurrent calls with different tools, prompts or abort signals
are isolated. Browser model/WASM bytes can come from the shared persistent
cache, but worker/model initialization occurs for every SDK request. Use a
standalone session if you want to keep one loaded worker alive across calls.

Supply `prompt`, or `messages` containing one text user turn preceded by optional
system messages. Provider-level `system` facts are combined with the request's
system facts. The WASM ABI cannot import arbitrary assistant history or tool
results, so the binding rejects those rather than dropping them. Multi-step
agent loops that send tool results back to Needle are not supported. Initial
SDK tool execution still works normally.

Needle is a tool-calling/extraction model. Free-form chat, images/audio/files in text requests,
provider-hosted tools, and mixing function tools with structured output in one
request are unsupported. Use `transcriptionModel()` for audio. Structured output needs an object JSON Schema and uses
the engine's supported schema subset. AI SDK validates the final output.

`streamText` emits content after inference completes, with a compatibility
warning in the SDK result. The engine has no token-stream callback. Token counts
are unavailable; the provider does not estimate them or substitute zero.
`providerMetadata.needle` retains the engine's confidence, suppressed calls,
grounding validation, and timings. Reasoning stays separate from generated text.

`toolChoice: 'auto'`, `'none'`, `'required'`, and a named tool are supported.
A required or structured output that the model withholds raises an error;
suppressed predictions never become executable calls. Unsupported settings such
as temperature and sampling penalties produce SDK warnings.

Pass `abortSignal` to the SDK call to cancel loading or inference. Cancelling the
underlying provider stream also aborts its worker. Cancellation affects that
request only, and the model object remains reusable.
