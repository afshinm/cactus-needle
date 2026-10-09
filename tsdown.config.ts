import { defineConfig, type UserConfig } from 'tsdown';
import { needleRuntime } from './build/needle-runtime.ts';

const output = {
  format: 'esm',
  target: 'es2022',
  fixedExtension: false,
  sourcemap: true,
  report: false,
} satisfies UserConfig;

export default defineConfig([
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
    // Keep import.meta.url next to each platform's worker and WASM assets.
    unbundle: true,
    platform: 'neutral',
    deps: { neverBundle: [/^node:/] },
    dts: true,
    // Consumers need async disposal types even without Node's ambient libraries.
    banner: { dts: '/// <reference lib="esnext.disposable" />' },
    publint: true,
  },
  {
    ...output,
    name: 'browser-worker',
    entry: { 'browser/worker': 'src/browser/worker.ts' },
    platform: 'browser',
    dts: false,
    define: { ENVIRONMENT_IS_NODE: 'false' },
    copy: [{ from: 'vendor/needle.wasm', to: 'dist/browser' }],
    plugins: [needleRuntime()],
    banner:
      '// Includes Cactus Compute Needle 3 loader, adapted to browser ESM. Apache-2.0; see NOTICE and vendor/LICENSE.',
  },
]);
