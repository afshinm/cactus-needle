import { fileURLToPath } from 'node:url';
import { defineConfig, type UserConfig } from 'tsdown';
import { verifyRuntime } from './build/verify-runtime.ts';

const output = {
  format: 'esm',
  target: 'es2022',
  fixedExtension: false,
  sourcemap: true,
  report: false,
} satisfies UserConfig;

export default defineConfig((options) => [
  {
    ...output,
    name: 'library',
    entry: [
      'src/index.ts',
      'src/browser/index.ts',
      'src/ai-sdk/index.ts',
      'src/ai-sdk/browser.ts',
      'src/node/worker.ts',
    ],
    root: 'src',
    // Preserve relative URLs for each platform's worker and WASM assets.
    unbundle: true,
    platform: 'neutral',
    deps: { neverBundle: [/^node:/] },
    dts: true,
    // Consumers need async disposal types even without Node's ambient libraries.
    banner: { dts: '/// <reference lib="esnext.disposable" />' },
    // Validate completed package builds; watch mode starts before all files exist.
    publint: !options.watch,
  },
  {
    ...output,
    name: 'browser-worker',
    entry: { 'browser/worker': 'src/browser/worker.ts' },
    platform: 'browser',
    dts: false,
    alias: {
      'needle-runtime': fileURLToPath(new URL('./vendor/needle.cjs', import.meta.url)),
    },
    // Use CommonJS interop and dead-code elimination to remove the loader's Node branches.
    define: { 'globalThis.process': 'undefined', __filename: 'undefined' },
    minify: true,
    deps: { neverBundle: [/^node:/] },
    plugins: [verifyRuntime()],
    banner:
      '// Includes Cactus Compute Needle 3 loader, bundled for the browser. Apache-2.0; see NOTICE and vendor/LICENSE.',
  },
]);
