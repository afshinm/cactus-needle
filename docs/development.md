# Development

See the [README](../README.md) for installation and usage.

## Setup

Use Node 22.18+ on the 22.x line, 24.11+ on the 24.x line, or Node 26+, with the
pnpm version pinned in `package.json`.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm check
pnpm test
```

Build before running checks or tests: they exercise the compiled package.
`pnpm dev` rebuilds on changes. `pnpm pack` builds and produces the npm tarball.

## Browser demo

`pnpm demo` starts the demos in `demo/`. The beat studio demonstrates multiple
tool calls from one request. Its opening example asks for a tempo, kick pattern,
and bass volume; Needle returns three independent calls. Other examples change
several track volumes or drum patterns. The exact prompt is visible and editable.
Relative requests such as “make the bass louder and the hats quieter” also work.

Each tool changes one musical control. There are no whole-beat presets or
scripted expansions of model responses. Web Audio synthesizes the instruments
and auditions edits immediately; the model predicts the actions and arguments.
Patterns remain editable by hand. The Lights tab keeps the smaller device-control
example. Results show timing and call count, with the actual tool calls behind
“View tools”.

Needle works best with concrete requests. Vague requests such as “make it more
fun” do not reliably produce a musical plan. The studio uses Needle's `triggers`
routing hints; matching hints can bypass the upstream confidence floor. No
withheld predictions are executed, and accepted calls are validated as a batch.

Both use plain HTML, TypeScript, and Tailwind through Vite. The public browser
client loads one session on the first request. Switching tabs passes the active
example's tools to `generate()` and keeps the worker and weights in memory.
Cancellation terminates the worker; retrying creates a new session from the
cached assets. `pnpm demo:build`
produces `demo/dist`; `pnpm demo:preview` serves that build locally.

The studio takes interaction cues from [Chrome Music Lab](https://musiclab.chromeexperiments.com/)
and [Ableton Learning Music](https://learningmusic.ableton.com/make-beats/make-beats.html).
Its schemas follow [Needle's tool-design guide](https://www.cactuscompute.com/blog/designing-tools-for-needle),
and its audio uses the [Web Audio lookahead scheduling pattern](https://web.dev/articles/audio-scheduling).

The `Demo` workflow publishes `demo/dist` on pushes to `main`. Set the repository's
Pages source to **GitHub Actions** in Settings → Pages. No API keys are needed.

## Build and lint

[tsdown](https://tsdown.dev/) compiles the library and declarations, cleans
`dist`, bundles the browser worker, and validates package exports
with [publint](https://publint.dev/). Library modules retain their directory
structure so relative worker and WASM URLs stay valid.
Configuration lives in `tsdown.config.ts`.

[Biome](https://biomejs.dev/) handles linting, formatting, and import organization
with its recommended rules:

| Command | Purpose |
| --- | --- |
| `pnpm lint` | Check lint, formatting, and imports |
| `pnpm lint:fix` | Apply safe fixes |
| `pnpm format` | Format files |
| `pnpm typecheck` | Check source and Node/browser consumer declarations |
| `pnpm check` | Run lint and type checks |

## Tests

All tests use Node's built-in test runner. For real inference tests, download the
pinned model into the ignored `.cache` directory and install Chromium:

```sh
pnpm model:download
pnpm exec playwright install chromium
pnpm test:integration
pnpm test:browser
pnpm test:pack
node examples/tool-calling.mjs
```

Set `NEEDLE_MODEL_PATH` to use an existing copy of the pinned base model for
integration, browser, and package tests. `NEEDLE_BROWSER_EXECUTABLE` selects
an existing Chromium binary.

Browser tests run WASM tool calling and embeddings. They check responsiveness,
session isolation, cancellation, cache reuse, corruption handling, and inference
with networking disabled.

`test:pack` installs the tarball into a fresh offline npm consumer. It checks
Node ESM/CommonJS imports and browser TypeScript declarations without Node
globals, then runs inference in Vite production and development builds. It
also exercises both supported AI SDK versions in Node and Chromium, with
networking denied in Node and browser model downloads blocked.

## Continuous integration

The `CI` workflow runs on pull requests, pushes to `main`, and merge queues.
It can also be started manually from GitHub Actions.

| Runner | Node.js | Checks |
| --- | --- | --- |
| Ubuntu 24.04 | 22.18.0, 24, 26 | Build, unit tests, and Node inference |
| macOS, Windows | 24 | Build, unit tests, and Node inference |
| Ubuntu 24.04 | 24 | Also lint, type checks, Chromium inference, and installed-package tests |

CI uses the pnpm version in `package.json` and installs from the frozen lockfile.
The pnpm store and model weights are cached. The model cache is keyed by
`vendor/manifest.json`; `model:download` verifies cached weights on every run.
Chromium and its system dependencies are installed with Playwright.

Actions are pinned to commit SHAs and updated weekly through Dependabot.
The workflow has read-only repository access, cancels superseded runs, and
limits each test job to 20 minutes. It uses the existing package scripts.

Use the final `CI` job as the required status check in branch protection. It
passes only when every test job passes, so the required check stays the same
when the matrix changes.

## Source layout

| Directory | Responsibility |
| --- | --- |
| `src/runtime/` | Shared WASM engine, session RPC, configuration, and artifact metadata |
| `src/node/` | Filesystem provisioning, worker threads, and Node options |
| `src/browser/` | Browser workers, asset caching, and browser options |
| `src/ai-sdk/` | Provider wiring, language and embedding models, request preparation, and session cleanup |

Root source modules define shared public types, schemas, the tool helper, and
errors. Entry points explicitly list public exports. Internal modules import
implementations directly. Artifact metadata comes from `vendor/manifest.json`;
the build does not generate source files.

## Dependencies

Compatible ranges in `package.json` allow updates. The committed `pnpm-lock.yaml`
and `--frozen-lockfile` make development installations reproducible.

- `@ai-sdk/provider` 3.x is a runtime dependency so the same provider works with
  AI SDK 6 and 7.
- `@types/json-schema` is a production dependency because the provider's published
  declarations reference it, but upstream only installs it for development.
- `ai` is an optional peer (`^6.0.0 || ^7.0.0`). Applications choose their SDK
  version; standalone installation does not pull in AI SDK core.
- `ai`, the `ai-v6` alias, and Zod are development dependencies for compatibility
  tests. Zod is not a peer: the standalone client accepts plain JSON Schema and
  compatible schema libraries without it.
- TypeScript stays on `~6.0.3` while the declaration plugin's
  [TypeScript 7 backend is experimental](https://github.com/sxzz/rolldown-plugin-dts#generators).
  Node types stay on 22.x to match the minimum supported Node major.

## Vendored assets

Only four files are kept in `vendor/`:

| File | Purpose |
| --- | --- |
| `needle.cjs` | Upstream JavaScript loader, renamed from `needle.js` without changing its contents |
| `needle.wasm` | One engine binary shared by Node and the browser |
| `manifest.json` | Upstream revision, download paths, sizes, and SHA-256 checksums |
| `LICENSE` | Upstream Apache-2.0 license |

The browser build uses tsdown's CommonJS support and minification to remove Node
branches. It does not patch the upstream source. `build/verify-runtime.ts`
verifies the pinned files and checks that the browser worker has no Node imports.

Two small setup scripts remain: `pnpm vendor:download` restores the pinned runtime
files, and `pnpm model:download` uses the public download API to populate the local
test cache. Neither runs during package installation. Model weights are downloaded
separately and are not in the tarball.

Upstream references:

- [Needle source and Python SDK](https://github.com/cactus-compute/needle)
- [Published weights and runtime](https://huggingface.co/Cactus-Compute/needle3)
- [Platform and C interface documentation](https://cactuscompute.com/blog/needle-supported-devices)

Keep the upstream Apache-2.0 license and required notices when redistributing
model weights. See [LICENSE](../LICENSE), [NOTICE](../NOTICE), and the
[upstream license](../vendor/LICENSE).
