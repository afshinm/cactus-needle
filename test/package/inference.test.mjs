import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { build, createServer, preview } from 'vite';
import { launchBrowser } from '../browser/launcher.mjs';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
const networkPreload = new URL('../fixtures/deny-network.mjs', import.meta.url).href;
const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const manifest = JSON.parse(await readFile(join(root, 'vendor/manifest.json'), 'utf8'));
const pinned = join(root, '.cache', manifest.revision, manifest.model.path);
const modelPath = resolve(
  process.env.NEEDLE_MODEL_PATH ||
    (existsSync(pinned) ? pinned : join(root, '.cache/needle3.cact')),
);
assert.ok(
  existsSync(modelPath),
  'Run npm run model:download or set NEEDLE_MODEL_PATH before test:pack.',
);
const npmCli = [
  join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
  resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
  ...(process.env.npm_execpath?.endsWith('npm-cli.js') ? [process.env.npm_execpath] : []),
].find(existsSync);
assert.ok(npmCli, 'npm must be installed alongside Node to test the tarball.');
test('packed package supports offline Node, Vite, and AI SDK 6 and 7', async (t) => {
  const consumer = await mkdtemp(join(tmpdir(), 'needle-package-'));

  // Package the already-installed runtime dependencies so the clean consumer install
  // stays offline. Do not rely on a global npm cache or a workspace dependency link.
  async function dependencyTarballs() {
    const output = join(consumer, 'dependencies');
    await mkdir(output);
    const seen = new Set();
    const archives = [];
    async function visit(name, from) {
      const path = createRequire(join(from, 'package.json')).resolve(`${name}/package.json`);
      const pkg = JSON.parse(await readFile(path, 'utf8'));
      const key = `${pkg.name}@${pkg.version}`;
      if (seen.has(key)) return;
      seen.add(key);
      for (const dependency of Object.keys(pkg.dependencies ?? {}))
        await visit(dependency, dirname(path));
      // npm 11 cannot reliably pack a directory inside pnpm's node_modules tree.
      const source = join(consumer, 'dependency-sources', key);
      await cp(dirname(path), source, { recursive: true });
      const { stdout } = await exec(
        process.execPath,
        [
          npmCli,
          'pack',
          source,
          '--ignore-scripts',
          '--json',
          '--pack-destination',
          output,
          '--cache',
          join(consumer, 'npm-cache'),
        ],
        { cwd: consumer },
      );
      archives.push(join(output, JSON.parse(stdout)[0].filename));
    }
    for (const name of Object.keys(metadata.dependencies ?? {})) await visit(name, root);
    return archives;
  }

  try {
    // Exercise prepack explicitly so lifecycle stdout cannot corrupt npm's JSON.
    await exec(
      process.execPath,
      [npmCli, 'run', 'prepack', '--cache', join(consumer, 'npm-cache')],
      {
        cwd: root,
      },
    );
    const { stdout } = await exec(
      process.execPath,
      [
        npmCli,
        'pack',
        '--ignore-scripts',
        '--json',
        '--pack-destination',
        root,
        '--cache',
        join(consumer, 'npm-cache'),
      ],
      { cwd: root },
    );
    const [packed] = JSON.parse(stdout);
    const files = new Set(packed.files.map((entry) => entry.path));
    for (const required of [
      'dist/index.js',
      'dist/index.d.ts',
      'dist/node/worker.js',
      'dist/node/api.js',
      'dist/client.js',
      'dist/speech-client.js',
      'dist/speech.d.ts',
      'dist/runtime/audio.js',
      'dist/runtime/resident.js',
      'dist/browser/index.js',
      'dist/browser/index.d.ts',
      'dist/browser/worker.js',
      'dist/browser/api.js',
      'dist/ai-sdk/index.js',
      'dist/ai-sdk/index.d.ts',
      'dist/ai-sdk/browser.js',
      'dist/ai-sdk/browser.d.ts',
      'dist/ai-sdk/transcription-model.js',
      'vendor/needle.cjs',
      'vendor/needle.wasm',
      'vendor/manifest.json',
      'vendor/LICENSE',
      'LICENSE',
      'NOTICE',
      'README.md',
    ]) {
      assert.ok(files.has(required), `Missing packed file: ${required}`);
    }
    assert.ok(files.has('docs/ai-sdk.md'), 'The README links to the packaged AI SDK guide.');
    assert.ok(
      [...files].every(
        (name) =>
          !name.endsWith('.cact') && !name.startsWith('test/') && !name.startsWith('node_modules/'),
      ),
    );
    const tarball = join(root, packed.filename);
    await writeFile(
      join(consumer, 'package.json'),
      JSON.stringify({ private: true, type: 'module' }),
    );
    await exec(
      process.execPath,
      [
        npmCli,
        'install',
        '--offline',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--cache',
        join(consumer, 'npm-cache'),
        tarball,
        ...(await dependencyTarballs()),
      ],
      { cwd: consumer },
    );
    assert.ok(
      !existsSync(join(consumer, 'node_modules/ai')),
      'Standalone installation must not pull in AI SDK core.',
    );
    const importName = JSON.stringify(metadata.name);
    const browserImport = JSON.stringify(`${metadata.name}/browser`);
    const sdkImport = JSON.stringify(`${metadata.name}/ai-sdk`);
    const browserSdkImport = JSON.stringify(`${metadata.name}/ai-sdk/browser`);
    await writeFile(
      join(consumer, 'smoke.mjs'),
      `
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createNeedle, Needle, Whistle, NeedleError, extract, transcribe, stream, close } from ${importName};
import { createNeedle as browserNeedle, Whistle as BrowserWhistle } from ${browserImport};
import { createNeedle as createProvider, createNeedleProvider } from ${sdkImport};
import { createNeedle as browserProvider, createNeedleProvider as legacyBrowserProvider } from ${browserSdkImport};
assert.equal(createRequire(import.meta.url)(${importName}).createNeedle, createNeedle);
assert.equal(createRequire(import.meta.url)(${importName}).Needle, Needle);
assert.equal(createRequire(import.meta.url)(${importName}).Whistle, Whistle);
for (const helper of [extract, transcribe, stream, close]) assert.equal(typeof helper, 'function');
await new BrowserWhistle().close(); // Construction and disposal are safe during SSR.
assert.equal(createRequire(import.meta.url)(${sdkImport}).createNeedle, createProvider);
assert.equal(createRequire(import.meta.url)(${sdkImport}).createNeedleProvider, createNeedleProvider);
assert.equal(createNeedleProvider, createProvider);
assert.equal(legacyBrowserProvider, browserProvider);
assert.equal(browserProvider()().modelId, 'needle3');
assert.equal(browserProvider().transcriptionModel().modelId, 'whistle');
assert.equal(new NeedleError('CLOSED', 'test').code, 'CLOSED');
await assert.rejects(browserNeedle(), {code:'UNSUPPORTED_ENVIRONMENT'});
const agent = await createNeedle({modelPath: process.argv[2], tools: [{name:'set_lights',description:'Turn the lights in a room on or off.',parameters:{type:'object',properties:{room:{type:'string'},on:{type:'boolean'}},required:['room','on']}}]});
try {
  assert.deepEqual((await agent.complete('Turn on the kitchen lights')).function_calls, [{name:'set_lights',arguments:{room:'kitchen',on:true}}]);
  assert.equal((await agent.embed('hello')).length, 3072);
} finally { await agent.close(); }
const resident = new Needle({weights:process.argv[2],download:false});
try {
  assert.equal((await resident.embed('hello')).length,3072);
  assert.deepEqual(await resident.extract('room: kitchen',{type:'object',properties:{room:{type:'string'}},required:['room']}),{room:'kitchen'});
} finally { await resident.close(); }
await close();
console.log('Installed tarball: ESM, CommonJS, and offline inference passed.');
`,
    );
    await writeFile(
      join(consumer, 'types.ts'),
      `
import {createNeedle, Needle, Whistle, transcribe, extract, type ToolDefinition, type CompletionResult, type EmbedOptions} from ${importName};
const tools = [{name:'test',parameters:{type:'object',properties:{enabled:{type:'boolean'}},required:['enabled']}}] as const satisfies readonly ToolDefinition[];
const agent = await createNeedle({tools,modelPath:'model.cact'});
const result: CompletionResult = await agent.complete('enable');
const vector: Float32Array = await agent.embed('enable');
await agent.close();
const resident = new Needle({weights:'model.cact',tools});
const options: EmbedOptions = {abortSignal:new AbortController().signal};
await resident.complete(undefined,options);
await resident.embed(undefined,options);
await resident.run();
const speech = new Whistle({weights:'whistle.cact'});
const transcript: string = (await transcribe('clip.wav')).text;
const record = await extract('room: kitchen',{type:'object',properties:{room:{type:'string'}},required:['room']});
const room:string|undefined = record?.room;
for await(const part of speech.stream([new Float32Array(16000)])) {const pending:string = part.pending; void pending;}
void [resident,speech,transcript,room];
void result; void vector;
`,
    );
    await exec(
      process.execPath,
      [
        join(root, 'node_modules/typescript/bin/tsc'),
        '--noEmit',
        '--strict',
        '--skipLibCheck',
        '--target',
        'ES2023',
        '--module',
        'NodeNext',
        '--moduleResolution',
        'NodeNext',
        '--types',
        'node',
        '--typeRoots',
        join(root, 'node_modules/@types'),
        'types.ts',
      ],
      { cwd: consumer },
    );
    const result = await exec(
      process.execPath,
      ['--import', networkPreload, 'smoke.mjs', modelPath],
      { cwd: consumer, timeout: 30_000 },
    );
    console.log(result.stdout.trim());
    // SDK versions are development fixtures. The provider and its own dependencies
    // above are the actual freshly installed tarballs, never source-directory links.
    for (const dependency of ['ai', 'ai-v6', 'zod']) {
      await symlink(
        join(root, 'node_modules', dependency),
        join(consumer, 'node_modules', dependency),
        'junction',
      );
    }
    await writeFile(
      join(consumer, 'sdk-smoke.mjs'),
      `
import assert from 'node:assert/strict';
import * as sdk7 from 'ai';
import * as sdk6 from 'ai-v6';
import {z} from 'zod';
import {createNeedle} from ${sdkImport};
const needle = createNeedle({modelPath:process.argv[2]});
for(const sdk of [sdk6,sdk7]) {
  const generated = await sdk.generateText({model:needle('needle3'),prompt:'Turn on the kitchen lights',tools:{set_lights:sdk.tool({description:'Turn the lights in a room on or off.',inputSchema:z.object({room:z.string(),on:z.boolean()})})}});
  assert.deepEqual(generated.toolCalls[0].input,{room:'kitchen',on:true});
  assert.equal((await sdk.embed({model:needle.embeddingModel(),value:'hello'})).embedding.length,3072);
}
console.log('Installed tarball: AI SDK 6 and 7 inference passed with networking denied.');
`,
    );
    const sdkResult = await exec(
      process.execPath,
      ['--import', networkPreload, 'sdk-smoke.mjs', modelPath],
      { cwd: consumer, timeout: 30_000 },
    );
    console.log(sdkResult.stdout.trim());
    await writeFile(
      join(consumer, 'browser-types.ts'),
      `
import {createNeedle, Needle, Whistle, transcribe, tool} from ${browserImport};
import {createNeedle as createProvider, type NeedleProviderSettings} from ${browserSdkImport};
import type {LanguageModelV3, EmbeddingModelV3, TranscriptionModelV3} from '@ai-sdk/provider';
const settings:NeedleProviderSettings = {model:'/model.cact'};
const sdkProvider = createProvider(settings);
const sdkModel:LanguageModelV3 = sdkProvider('needle3');
const embeddingModel:EmbeddingModelV3 = sdkProvider.embeddingModel();
const transcriptionModel:TranscriptionModelV3 = sdkProvider.transcriptionModel();
const speech = new Whistle({weights:'/whistle.cact'});
const speechText:string = (await transcribe(new File([],'clip.wav'))).text;
const resident = new Needle({weights:'/model.cact'});
await resident.complete(); await resident.embed(); await resident.run();
void [sdkModel,embeddingModel,transcriptionModel,speech,speechText,resident];
const needle = await createNeedle({tools:{lights:tool({inputSchema:{type:'object',properties:{on:{type:'boolean'}},required:['on']}})}});
const result = await needle.generate({prompt:'on'});
const on: boolean = result.toolCalls[0].input.on;
await needle.close(); void on;
`,
    );
    await writeFile(
      join(consumer, 'tsconfig.browser.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2023',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          lib: ['ES2023', 'DOM'],
          strict: true,
          noEmit: true,
          types: [],
        },
        files: ['browser-types.ts'],
      }),
    );
    await exec(
      process.execPath,
      [join(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.browser.json'],
      { cwd: consumer },
    );
    await mkdir(join(consumer, 'public'));
    await copyFile(modelPath, join(consumer, 'public/model.cact'));
    await writeFile(
      join(consumer, 'index.html'),
      '<!doctype html><title>Installed Needle package</title><script type="module" src="/main.js"></script>',
    );
    await writeFile(
      join(consumer, 'main.js'),
      `
import {createNeedle, tool} from ${browserImport};
import {createNeedle as rootEntry} from ${importName};
import {createNeedle as createProvider, createNeedleProvider} from ${browserSdkImport};
import {createNeedle as sdkRootEntry} from ${sdkImport};
import * as sdk7 from 'ai';
import * as sdk6 from 'ai-v6';
import {z} from 'zod';
globalThis.AI_SDK_LOG_WARNINGS = false;
window.runNeedle = async () => {
  if(rootEntry !== createNeedle) throw new Error('Root browser export resolved incorrectly.');
  const needle = await createNeedle({model:'/model.cact',tools:{set_lights:tool({description:'Turn the lights in a room on or off.',inputSchema:{type:'object',properties:{room:{type:'string'},on:{type:'boolean'}},required:['room','on']}})}});
  try { return {generated:await needle.generate({prompt:'Turn on the kitchen lights'}),dimension:(await needle.embed('hello')).length}; }
  finally {await needle.close();}
};
window.runSDK = async (version,offline) => {
  if(sdkRootEntry !== createProvider) throw new Error('SDK browser export resolved incorrectly.');
  if(createNeedleProvider !== createProvider) throw new Error('SDK compatibility alias resolved incorrectly.');
  const sdk = version === 6 ? sdk6 : sdk7;
  const needle = createProvider({model:'/model.cact',offline});
  const schema = z.object({room:z.string(),on:z.boolean()});
  const tools = {set_lights:sdk.tool({description:'Turn the lights in a room on or off.',inputSchema:schema})};
  const generated = await sdk.generateText({model:needle(),tools,prompt:'Turn on the kitchen lights'});
  const stream = sdk.streamText({model:needle(),tools,prompt:'Turn off the bedroom lights'});
  const events = [];
  for await(const event of stream.fullStream) events.push(event.type);
  const streamed = await stream.toolCalls;
  const dimension = (await sdk.embed({model:needle.embeddingModel(),value:'hello'})).embedding.length;
  const structured = (await sdk.generateText({model:needle(),output:sdk.Output.object({schema}),prompt:'room: kitchen, on: true'})).output;
  return {generated:{toolCalls:generated.toolCalls,providerMetadata:generated.providerMetadata},streamed,dimension,structured,events};
};
`,
    );
    const config = {
      root: consumer,
      configFile: false,
      logLevel: 'warn',
      build: { outDir: 'site', target: 'es2022' },
    };
    await build(config);
    await t.test('packed package browser inference', async () => {
      const browser = await launchBrowser();
      try {
        for (const mode of ['production', 'development']) {
          const server =
            mode === 'production'
              ? await preview({ ...config, preview: { host: '127.0.0.1', port: 0 } })
              : await createServer({ ...config, server: { host: '127.0.0.1', port: 0 } });
          if (mode === 'development') await server.listen();
          const page = await browser.newPage();
          try {
            await page.goto(`http://127.0.0.1:${server.httpServer.address().port}`);
            await page.waitForFunction(() => typeof window.runNeedle === 'function');
            const result = await page.evaluate(() => window.runNeedle());
            assert.deepEqual(result.generated.toolCalls, [
              { toolName: 'set_lights', input: { room: 'kitchen', on: true } },
            ]);
            assert.equal(result.dimension, 3072);
            console.log(`Installed tarball: Vite ${mode} browser inference passed.`);
            // Keep worker scripts available but deny model/WASM downloads: SDK calls
            // must reuse the verified bytes cached by the standalone client above.
            await page.route(/model\.cact|\.wasm/, (route) => route.abort());
            for (const version of [6, 7]) {
              const sdk = await page.evaluate((version) => window.runSDK(version, true), version);
              assert.deepEqual(sdk.generated.toolCalls[0].input, { room: 'kitchen', on: true });
              assert.deepEqual(sdk.streamed[0].input, { room: 'bedroom', on: false });
              assert.equal(sdk.dimension, 3072);
              assert.deepEqual(sdk.structured, { room: 'kitchen', on: true });
              assert.ok(sdk.events.includes('finish'));
              console.log(
                `Installed tarball: AI SDK ${version} in Vite ${mode} passed with model downloads blocked.`,
              );
            }
          } finally {
            await page.close();
            if (mode === 'development') await server.close();
            else
              await new Promise((done) => {
                server.httpServer.closeAllConnections();
                server.httpServer.close(done);
              });
          }
        }
      } finally {
        await browser.close();
      }
    });
    console.log(
      `Created ${tarball} (${packed.size} bytes compressed, ${packed.unpackedSize} bytes unpacked).`,
    );
  } finally {
    await rm(consumer, { recursive: true, force: true });
  }
});
