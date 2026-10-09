import { Agent } from '../client.js';
import { NeedleError, validateInteger } from '../errors.js';
import { DEFAULT_MODEL, DEFAULT_SPEECH_MODEL } from '../runtime/artifacts.js';
import { configuration } from '../runtime/configuration.js';
import { RpcSession } from '../runtime/rpc-session.js';
import type { Whistle } from '../speech.js';
import { SpeechClient } from '../speech-client.js';
import type { ToolCollection } from '../tools.js';
import type { Needle } from '../types.js';
import { readAudio } from './audio.js';
import type { BrowserConfig, BrowserRequest, BrowserResponse } from './protocol.js';
import type { BrowserNeedleOptions, BrowserWhistleOptions } from './types.js';

function resolveUrl(value: string | URL, label: string): string {
  try {
    const url = new URL(value, globalThis.location?.href);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Expected an HTTP(S) URL.');
    return url.href;
  } catch (cause) {
    throw new NeedleError(
      'INVALID_ARGUMENT',
      `${label} must be an HTTP(S) URL or page-relative path.`,
      { cause },
    );
  }
}

/** Load a local browser session. Only setup fetches assets; inference stays in the worker. */
export async function createNeedle<const Tools extends ToolCollection = ToolCollection>(
  options: BrowserNeedleOptions<Tools> = {},
): Promise<Needle<Tools>> {
  const agent = new Agent<Tools>(
    (signal) => loadSession({ ...options, stateless: false, abortSignal: signal }, 'needle3'),
    options,
  );
  try {
    await agent.ready(options.abortSignal);
    return agent;
  } catch (error) {
    await agent.close();
    throw error;
  }
}

/** Load and cache Whistle separately from the text model. Reuse this session for each recording. */
export async function createWhistle(options: BrowserWhistleOptions = {}): Promise<Whistle> {
  const speech = new SpeechClient(
    (signal) => loadSession({ ...options, abortSignal: signal }, 'whistle'),
    readAudio,
  );
  try {
    await speech.ready(options.abortSignal);
    return speech;
  } catch (error) {
    await speech.close();
    throw error;
  }
}

export async function loadSession<Tools extends ToolCollection>(
  options: BrowserNeedleOptions<Tools>,
  modelKind: 'needle3' | 'whistle',
): Promise<RpcSession<Tools>> {
  options.abortSignal?.throwIfAborted();
  const artifact = modelKind === 'needle3' ? DEFAULT_MODEL : DEFAULT_SPEECH_MODEL;
  const shared = configuration(options);
  const tokens = validateInteger(
    options.maxOutputTokens ?? options.maxNewTokens ?? 512,
    'maxOutputTokens',
    1,
    65_536,
  );
  for (const key of ['cache', 'offline'] as const) {
    if (options[key] !== undefined && typeof options[key] !== 'boolean')
      throw new NeedleError('INVALID_ARGUMENT', `${key} must be a boolean.`);
  }
  if (options.modelSha256 !== undefined && !/^[a-f0-9]{64}$/i.test(options.modelSha256))
    throw new NeedleError(
      'INVALID_ARGUMENT',
      'modelSha256 must be a 64-character hex SHA-256 digest.',
    );
  if (options.onDownloadProgress !== undefined && typeof options.onDownloadProgress !== 'function')
    throw new NeedleError('INVALID_ARGUMENT', 'onDownloadProgress must be a function.');
  const input = options.model ?? artifact.url;
  const model =
    typeof input === 'string' || input instanceof URL
      ? resolveUrl(input, 'model')
      : input instanceof ArrayBuffer
        ? new Uint8Array(input.slice(0))
        : input instanceof Uint8Array
          ? new Uint8Array(input)
          : undefined;
  if (model === undefined)
    throw new NeedleError('INVALID_ARGUMENT', 'model must be a URL, ArrayBuffer, or Uint8Array.');
  const pinned = model === artifact.url;
  if (
    pinned &&
    options.modelSha256 !== undefined &&
    options.modelSha256.toLowerCase() !== artifact.sha256
  )
    throw new NeedleError('INVALID_ARGUMENT', 'The default model checksum cannot be overridden.');
  const config: BrowserConfig = {
    ...shared,
    modelKind,
    model,
    wasmUrl:
      options.wasmUrl === undefined
        ? new URL('../../vendor/needle.wasm', import.meta.url).href
        : resolveUrl(options.wasmUrl, 'wasmUrl'),
    cache: options.cache ?? true,
    offline: options.offline ?? false,
    ...(pinned
      ? { modelSha256: artifact.sha256, modelSize: artifact.size }
      : options.modelSha256
        ? { modelSha256: options.modelSha256.toLowerCase() }
        : {}),
  };
  if (typeof Worker === 'undefined' || typeof WebAssembly === 'undefined')
    throw new NeedleError(
      'UNSUPPORTED_ENVIRONMENT',
      'Use the browser entry in a browser with WebAssembly and module workers. For Node.js, import cactus-needle.',
    );
  if (!globalThis.crypto?.subtle)
    throw new NeedleError(
      'UNSUPPORTED_ENVIRONMENT',
      'Browser inference requires HTTPS or localhost for integrity verification.',
    );
  let worker: Worker;
  try {
    // Keep this exact static URL pattern so Vite and Webpack can emit the worker.
    worker =
      options.workerUrl === undefined
        ? new Worker(new URL('./worker.js', import.meta.url), {
            type: 'module',
            name: 'cactus-needle',
          })
        : new Worker(resolveUrl(options.workerUrl, 'workerUrl'), {
            type: 'module',
            name: 'cactus-needle',
          });
  } catch (cause) {
    throw new NeedleError(
      'WORKER_ERROR',
      'Cannot start the inference worker. Check workerUrl and your worker-src Content Security Policy.',
      { cause },
    );
  }
  const session = new RpcSession<Tools>(
    {
      send: (request) => worker.postMessage(request),
      terminate: async () => {
        worker.terminate();
      },
      listen(onMessage, onError) {
        worker.onmessage = ({ data }: MessageEvent<BrowserResponse>) => {
          if (data.type === 'progress') {
            try {
              options.onDownloadProgress?.(data.progress);
            } catch (error) {
              onError(error instanceof Error ? error : new Error(String(error)));
            }
          } else onMessage(data);
        };
        worker.onerror = (event) => {
          event.preventDefault();
          onError(new Error(event.message || 'Could not load worker.'));
        };
        worker.onmessageerror = () => onError(new Error('Could not decode a worker message.'));
      },
    },
    tokens,
  );
  const abort = () => {
    void session.close();
  };
  options.abortSignal?.addEventListener('abort', abort, { once: true });
  try {
    worker.postMessage(
      { type: 'init', config } satisfies BrowserRequest,
      model instanceof Uint8Array ? [model.buffer] : [],
    );
    await session.ready;
    options.abortSignal?.throwIfAborted();
    return session;
  } catch (error) {
    await session.close();
    if (options.abortSignal?.aborted) throw options.abortSignal.reason;
    throw error;
  } finally {
    options.abortSignal?.removeEventListener('abort', abort);
  }
}
