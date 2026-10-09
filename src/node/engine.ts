import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { errorMessage, NeedleError } from '../errors.js';
import { Engine, type Factory, inspectModel } from '../runtime/engine.js';
import type { WorkerConfig } from './protocol.js';

export async function loadNodeEngine(config: WorkerConfig): Promise<Engine> {
  let data: Uint8Array;
  try {
    data = await readFile(config.modelPath);
  } catch (cause) {
    const missing = (cause as NodeJS.ErrnoException).code === 'ENOENT';
    throw new NeedleError(
      missing ? 'MODEL_NOT_FOUND' : 'INVALID_MODEL',
      missing
        ? `Model not found: ${config.modelPath}. Call downloadModel(${config.modelKind === 'whistle' ? "{ model: 'whistle' }" : ''}) explicitly or provide modelPath.`
        : `Cannot read model ${config.modelPath}: ${errorMessage(cause)}`,
      { cause },
    );
  }
  if (
    config.expectedSha256 &&
    createHash('sha256').update(data).digest('hex') !== config.expectedSha256
  ) {
    throw new NeedleError(
      'INTEGRITY_ERROR',
      'Cached model failed SHA-256 verification. Remove it and run downloadModel() again.',
    );
  }
  inspectModel(data);
  const factory = createRequire(import.meta.url)('../../vendor/needle.cjs') as Factory;
  const wasmBinary = await readFile(new URL('../../vendor/needle.wasm', import.meta.url));
  return Engine.create(await factory({ wasmBinary }), config, data);
}
