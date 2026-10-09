# cactus-needle

Run [Needle 3](https://github.com/cactus-compute/needle) locally in a browser or
Node.js for tool calling, structured extraction, and text embeddings. Use it directly
or as a [Vercel AI SDK](https://ai-sdk.dev/) provider.

The 35.3 MB model downloads separately and runs in a WebAssembly worker on the
CPU. Inference needs no API key, server, or GPU.

![The standalone client and AI SDK provider both run Needle 3 in a local worker, in your browser or Node.js.](docs/runtime.svg)

## Install

```sh
npm install cactus-needle
```

## Browser

Requires HTTPS or localhost. Tested with Vite and Chromium.

```js
import { createNeedle, tool } from 'cactus-needle/browser';

const needle = await createNeedle({
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
  const { toolCalls } = await needle.generate({
    prompt: 'Turn on the kitchen lights',
  });
  console.log(toolCalls);
  // [{ toolName: 'set_lights', input: { room: 'kitchen', on: true } }]
} finally {
  await needle.close();
}
```

The first load downloads the model from Hugging Face and caches it when browser
storage is available. Reuse the session across requests; pass `tools` to
`generate()` to change the available actions without reloading the model.
Your app decides which predicted tool calls to execute.

## Node.js

Requires Node.js 22.18+.

```js
import { createNeedle, downloadModel } from 'cactus-needle';

const modelPath = await downloadModel();
const needle = await createNeedle({ modelPath });

try {
  const embedding = await needle.embed('kitchen lights');
  console.log(embedding.length); // 3072
} finally {
  await needle.close();
}
```

`downloadModel()` reuses cached weights. Node supports the same tools and
`generate()` API as the browser.

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
browser setup, structured output, and embeddings. Standalone users do not need `ai`.

## Imports

| Use | Import from |
| --- | --- |
| Standalone, Node.js | `cactus-needle` |
| Standalone, browser | `cactus-needle/browser` |
| AI SDK, Node.js | `cactus-needle/ai-sdk` |
| AI SDK, browser | `cactus-needle/ai-sdk/browser` |

The standalone `createNeedle()` loads a session and must be awaited. The AI SDK
version creates a provider.

## Limits

- Free-form chat, audio, and images are unsupported.
- The AI SDK provider accepts one user turn plus optional system messages.
  Agent loops that send tool results back to the model are unsupported.
- Streaming is buffered; results arrive when inference finishes.

## Documentation

- [Standalone API](docs/usage.md)
- [AI SDK guide](docs/ai-sdk.md)
- [Development](docs/development.md)

## License

Apache-2.0. An independent wrapper for Cactus Compute's Needle. See
[LICENSE](LICENSE), [NOTICE](NOTICE), and the [upstream license](vendor/LICENSE).
