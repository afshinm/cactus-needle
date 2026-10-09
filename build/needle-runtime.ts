import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { TsdownPlugin } from 'tsdown';
import manifest from '../vendor/manifest.json' with { type: 'json' };

const vendor = new URL('../vendor/', import.meta.url);
const runtimeId = '\0needle-runtime';

/** The upstream loader is CommonJS; adapt only its wrapper for the browser worker. */
export function needleRuntime(): TsdownPlugin {
  return {
    name: 'needle-runtime',
    async buildStart() {
      this.addWatchFile(fileURLToPath(new URL('manifest.json', vendor)));
      for (const [name, artifact] of Object.entries(manifest.files)) {
        const file = new URL(name, vendor);
        this.addWatchFile(fileURLToPath(file));
        const bytes = await readFile(file);
        assert.equal(bytes.length, artifact.size, `${name}: size mismatch`);
        assert.equal(
          createHash('sha256').update(bytes).digest('hex'),
          artifact.sha256,
          `${name}: SHA-256 mismatch`,
        );
      }
    },
    resolveId(id) {
      if (id === 'needle-runtime') return runtimeId;
    },
    async load(id) {
      if (id !== runtimeId) return;
      let source = await readFile(new URL('needle.js', vendor), 'utf8');
      const replacements = [
        [
          'var ENVIRONMENT_IS_NODE=globalThis.process?.versions?.node&&globalThis.process?.type!="renderer";',
          '',
        ],
        [
          'if(typeof __filename!="undefined"){_scriptName=__filename}else if(ENVIRONMENT_IS_WORKER)',
          'if(ENVIRONMENT_IS_WORKER)',
        ],
        [
          'if(typeof exports==="object"&&typeof module==="object"){module.exports=createNeedle;module.exports.default=createNeedle}else if(typeof define==="function"&&define["amd"])define([],()=>createNeedle);',
          'export default createNeedle;',
        ],
      ] as const;
      for (const [before, after] of replacements) {
        assert.ok(source.includes(before), 'Pinned loader changed; review the browser adaptation.');
        source = source.replace(before, after);
      }
      return source;
    },
    generateBundle(_options, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type === 'chunk') {
          assert.ok(
            !/["']node:|\bprocess\.|\brequire\(/.test(chunk.code),
            'Node dependency leaked into the browser worker.',
          );
        }
      }
    },
  };
}
