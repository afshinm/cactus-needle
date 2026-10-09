import { errorMessage, NeedleError } from '../errors.js';
import { DEFAULT_MODEL, WASM_ARTIFACT } from '../runtime/artifacts.js';
import { inspectModel } from '../runtime/engine.js';
import type { BrowserConfig } from './protocol.js';
import type { DownloadProgress } from './types.js';

const CACHE = `cactus-needle-${DEFAULT_MODEL.revision}`;
type Bytes = Uint8Array<ArrayBuffer>;

async function verify(
  bytes: Bytes,
  sha256: string | undefined,
  size: number | undefined,
  model: boolean,
): Promise<void> {
  if (size !== undefined && bytes.length !== size)
    throw new NeedleError('INTEGRITY_ERROR', 'Asset size does not match the pinned artifact.');
  if (sha256) {
    if (!globalThis.crypto?.subtle)
      throw new NeedleError(
        'UNSUPPORTED_ENVIRONMENT',
        'Model integrity verification requires HTTPS or localhost.',
      );
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    const actual = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
    if (actual !== sha256)
      throw new NeedleError('INTEGRITY_ERROR', 'Asset failed SHA-256 verification.');
  }
  if (model) inspectModel(bytes);
}

async function read(
  response: globalThis.Response,
  size: number | undefined,
  progress?: (value: DownloadProgress) => void,
): Promise<Bytes> {
  if (!response.ok || !response.body)
    throw new NeedleError('DOWNLOAD_FAILED', `Asset download failed: HTTP ${response.status}.`);
  const length = Number(response.headers.get('content-length'));
  const total = size ?? (length > 0 ? length : undefined);
  const reader = response.body.getReader();
  const chunks: Bytes[] = [];
  let loaded = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      loaded += value.byteLength;
      if (size !== undefined && loaded > size)
        throw new NeedleError('INTEGRITY_ERROR', 'Asset exceeds its pinned size.');
      chunks.push(value);
      progress?.({
        loaded,
        ...(total === undefined
          ? {}
          : { total, percentage: Math.min(100, (loaded / total) * 100) }),
      });
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

async function asset(
  url: string,
  config: BrowserConfig,
  model: boolean,
  progress?: (value: DownloadProgress) => void,
): Promise<Bytes> {
  const sha256 = model ? config.modelSha256 : WASM_ARTIFACT.sha256;
  const size = model ? config.modelSize : WASM_ARTIFACT.size;
  // Include integrity in the key so a custom model revision cannot reuse old bytes.
  const key = new URL(url);
  if (sha256) key.searchParams.set('__needle_sha256', sha256);
  let cache: Cache | undefined;
  if (config.cache) {
    try {
      cache = await globalThis.caches?.open(CACHE);
    } catch {
      /* Private browsing or storage policy may deny caching. */
    }
  }
  let cached: globalThis.Response | undefined;
  try {
    cached = await cache?.match(key.href);
  } catch {
    /* Continue without persistent storage. */
  }
  if (cached) {
    const bytes = new Uint8Array(await cached.arrayBuffer());
    try {
      await verify(bytes, sha256, size, model);
    } catch (error) {
      await cache?.delete(key.href).catch(() => {});
      throw error;
    }
    progress?.({ loaded: bytes.length, total: bytes.length, percentage: 100 });
    return bytes;
  }
  if (config.offline)
    throw new NeedleError(
      'MODEL_NOT_FOUND',
      `Offline asset is not cached: ${url}. Load it once online with cache enabled.`,
    );
  let bytes: Bytes;
  try {
    bytes = await read(await fetch(url, { credentials: 'same-origin' }), size, progress);
  } catch (error) {
    if (error instanceof NeedleError) throw error;
    throw new NeedleError(
      'DOWNLOAD_FAILED',
      `Cannot load ${model ? 'model' : 'WASM'}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  await verify(bytes, sha256, size, model);
  try {
    await cache?.put(
      key.href,
      new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } }),
    );
  } catch {
    /* Quota or policy failures must not prevent inference with verified bytes. */
  }
  progress?.({ loaded: bytes.length, total: bytes.length, percentage: 100 });
  return bytes;
}

export async function loadAssets(
  config: BrowserConfig,
  progress: (value: DownloadProgress) => void,
): Promise<{ model: Bytes; wasmBinary: Bytes }> {
  const model =
    typeof config.model === 'string'
      ? await asset(config.model, config, true, progress)
      : config.model;
  if (typeof config.model !== 'string') {
    await verify(model, config.modelSha256, config.modelSize, true);
    progress({ loaded: model.length, total: model.length, percentage: 100 });
  }
  const wasmBinary = await asset(config.wasmUrl, config, false);
  return { model, wasmBinary };
}
