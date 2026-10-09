import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, type Stats } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { errorMessage, NeedleError, validateInteger } from '../errors.js';
import { DEFAULT_MODEL as MODEL, MODEL_FILE } from '../runtime/artifacts.js';
import type { DownloadOptions } from './types.js';

// Preserve the Node entry's public metadata types while sharing manifest values.
export const DEFAULT_MODEL: Readonly<{
  name: 'needle3';
  revision: string;
  size: number;
  sha256: string;
  url: `https://huggingface.co/${string}/resolve/${string}/${string}`;
}> = MODEL;

/** Locate the default model without reading the file or using the network. */
export function getModelPath(cacheDir?: string): string {
  const root =
    cacheDir ??
    join(
      process.env.XDG_CACHE_HOME ||
        (process.platform === 'win32' && process.env.LOCALAPPDATA) ||
        join(homedir(), '.cache'),
      'cactus-needle-node',
    );
  return resolve(root, DEFAULT_MODEL.revision, MODEL_FILE);
}

async function verifiedCache(path: string): Promise<boolean> {
  let info: Stats;
  try {
    info = await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  if (!info.isFile() || info.size !== DEFAULT_MODEL.size) {
    throw new NeedleError(
      'INTEGRITY_ERROR',
      `Cached model has the wrong size. Remove ${path} and download it again.`,
    );
  }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  if (hash.digest('hex') !== DEFAULT_MODEL.sha256) {
    throw new NeedleError(
      'INTEGRITY_ERROR',
      `Cached model failed SHA-256 verification. Remove ${path} and download it again.`,
    );
  }
  return true;
}

/** Explicitly download the pinned model. Verified cache hits do not make any network requests. */
export async function downloadModel(options: DownloadOptions = {}): Promise<string> {
  options.signal?.throwIfAborted();
  const timeout = validateInteger(options.timeoutMs ?? 300_000, 'timeoutMs', 1, 2_147_483_647);
  const target = getModelPath(options.cacheDir);
  if (await verifiedCache(target)) return target;
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.part`;
  const signal = AbortSignal.any([
    AbortSignal.timeout(timeout),
    ...(options.signal ? [options.signal] : []),
  ]);
  try {
    const response = await fetch(DEFAULT_MODEL.url, { signal });
    if (!response.ok || !response.body) {
      throw new NeedleError('DOWNLOAD_FAILED', `Model download failed: HTTP ${response.status}.`);
    }
    const hash = createHash('sha256');
    let received = 0;
    const verify = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        try {
          received += chunk.length;
          if (received > DEFAULT_MODEL.size) {
            throw new NeedleError('INTEGRITY_ERROR', 'Downloaded model exceeds its pinned size.');
          }
          hash.update(chunk);
          options.onProgress?.({ receivedBytes: received, totalBytes: DEFAULT_MODEL.size });
          callback(null, chunk);
        } catch (error) {
          callback(error as Error);
        }
      },
    });
    await pipeline(
      Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>),
      verify,
      createWriteStream(temporary, { flags: 'wx', mode: 0o600 }),
      { signal },
    );
    if (received !== DEFAULT_MODEL.size || hash.digest('hex') !== DEFAULT_MODEL.sha256) {
      throw new NeedleError(
        'INTEGRITY_ERROR',
        'Downloaded model failed size or SHA-256 verification.',
      );
    }
    await rename(temporary, target);
    return target;
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (error instanceof NeedleError) throw error;
    throw new NeedleError('DOWNLOAD_FAILED', `Model download failed: ${errorMessage(error)}`, {
      cause: error,
    });
  } finally {
    await rm(temporary, { force: true });
  }
}
