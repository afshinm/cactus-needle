# cactus-needle

Run [Needle](https://github.com/cactus-compute/needle) and
[Whistle](https://www.cactuscompute.com/blog/whistle) locally in a browser or Node.js.
Tool calling, structured extraction, embeddings, and speech to text, with a
standalone API familiar to Python users and a [Vercel AI SDK](https://ai-sdk.dev/) provider.

Needle is 35.3 MB; Whistle is 16.9 MB. Each downloads when needed and runs in a
WebAssembly worker on the CPU. Inference needs no API key, server, or GPU.

![The standalone client and AI SDK provider run Needle and Whistle in local workers.](docs/runtime.svg)

## Install

```sh
npm install cactus-needle
```

## Speech to text

```js
import * as needle from 'cactus-needle';

console.log((await needle.transcribe('clip.wav')).text);
await needle.close();
```

Like Python's `needle.transcribe()`, the helper loads and reuses Whistle. It accepts
WAV files or PCM samples, up to 30 seconds per call. In browsers, import from
`cactus-needle/browser` and pass a URL, `File`, or samples. See the
[speech guide](docs/usage.md#speech) for streaming, languages, and word timestamps.

## Browser

Requires HTTPS or localhost. Tested with Vite and Chromium.

```js
import { Needle, tool } from 'cactus-needle/browser';

const needle = new Needle({
  tools: {
    set_lights: tool({
      description: 'Turn the lights in a room on or off.',
      inputSchema: {
        type: 'object',
        properties: { room: { type: 'string' }, on: { type: 'boolean' } },
        required: ['room', 'on'],
      },
    }),
  },
});

try {
  const result = await needle.complete('Turn on the kitchen lights');
  console.log(result.function_calls);
  // [{ name: 'set_lights', arguments: { room: 'kitchen', on: true } }]
} finally {
  await needle.close();
}
```

The first call downloads the model from Hugging Face and caches it when browser
storage is available. Reuse the session across requests; pass `tools` to
`complete()` or `generate()` to change the available actions without reloading.
To execute tools and feed their results back to Needle, add an `execute` callback
to each tool and call [`needle.run(text)`](docs/usage.md#running-tools).

## Node.js

Requires Node.js 22.18+.

```js
import { Needle } from 'cactus-needle';

const needle = new Needle();

try {
  const embedding = await needle.embed('kitchen lights');
  console.log(embedding.length); // 3072
} finally {
  await needle.close();
}
```

The constructor loads on first use and reuses cached weights. Pass `weights` for
a local model or `download: false` for offline setup. Node supports the same
tools and methods as the browser.

## Vercel AI SDK

Supports AI SDK 6 and 7. Install the SDK and, for this example, Zod:

```sh
npm install ai zod
```

This example runs in Node.js:

```ts
import { generateText } from 'ai';
import { downloadModel } from 'cactus-needle';
import { createNeedle } from 'cactus-needle/ai-sdk';
import { z } from 'zod';

const modelPath = await downloadModel();
const needle = createNeedle({ modelPath });

const { toolCalls } = await generateText({
  model: needle('needle3'),
  tools: {
    set_lights: {
      description: 'Turn the lights in a room on or off.',
      inputSchema: z.object({ room: z.string(), on: z.boolean() }),
    },
  },
  prompt: 'Turn on the kitchen lights',
});

console.log(toolCalls);
```

The provider handles worker cleanup. See the [AI SDK guide](docs/ai-sdk.md) for
browser setup, structured output, embeddings, and `needle.transcriptionModel('whistle')`.
Standalone users do not need `ai`.

## Imports

| Use | Import from |
| --- | --- |
| Standalone, Node.js | `cactus-needle` |
| Standalone, browser | `cactus-needle/browser` |
| AI SDK, Node.js | `cactus-needle/ai-sdk` |
| AI SDK, browser | `cactus-needle/ai-sdk/browser` |

`new Needle()` and `new Whistle()` load lazily. The existing standalone factories
`await createNeedle()` and `await createWhistle()` load immediately; in Node they
use already-provisioned weights. The AI SDK's `createNeedle()` creates a provider.

## Limits

- Needle handles tool calls and extraction, not free-form chat or images.
- Whistle accepts uncompressed WAV or mono PCM. Decode MP3, WebM, and other
  compressed formats before passing them to the standalone client.
- The AI SDK provider accepts one user turn plus optional system messages.
  Use standalone `run()` for Needle's tool loop.
- Text streaming is buffered. Whistle's standalone `stream()` processes live audio chunks.

## Documentation

- [Standalone API](docs/usage.md)
- [AI SDK guide](docs/ai-sdk.md)
- [Development](docs/development.md)

## License

Apache-2.0. An independent wrapper for Cactus Compute's Needle. See
[LICENSE](LICENSE), [NOTICE](NOTICE), and the [upstream license](vendor/LICENSE).
