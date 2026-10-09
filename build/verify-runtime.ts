import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { TsdownPlugin } from 'tsdown';
import manifest from '../vendor/manifest.json' with { type: 'json' };

const vendor = new URL('../vendor/', import.meta.url);

/** Verify upstream bytes and reject Node dependencies in the browser worker. */
export function verifyRuntime(): TsdownPlugin {
  return {
    name: 'verify-needle-runtime',
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
