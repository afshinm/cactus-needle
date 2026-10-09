import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { Agent } from '../client.js';
import { NeedleError, validateInteger, validateText } from '../errors.js';
import { DEFAULT_MODEL, DEFAULT_SPEECH_MODEL } from '../runtime/artifacts.js';
import { configuration } from '../runtime/configuration.js';
import { RpcSession } from '../runtime/rpc-session.js';
import type { Whistle } from '../speech.js';
import { SpeechClient } from '../speech-client.js';
import type { ToolCollection } from '../tools.js';
import type { Needle } from '../types.js';
import { readAudio } from './audio.js';
import { getModelPath } from './model.js';
import type { WorkerConfig } from './protocol.js';
import type { NeedleOptions, WhistleOptions } from './types.js';

/** Load a local model in its own worker. This function never accesses the network. */
export async function createNeedle<const Tools extends ToolCollection = ToolCollection>(
  options: NeedleOptions<Tools> = {},
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

/** Load local Whistle weights once. Provision them with downloadModel({ model: 'whistle' }). */
export async function createWhistle(options: WhistleOptions = {}): Promise<Whistle> {
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
  options: NeedleOptions<Tools>,
  modelKind: 'needle3' | 'whistle',
): Promise<RpcSession<Tools>> {
  options.abortSignal?.throwIfAborted();
  const artifact = modelKind === 'needle3' ? DEFAULT_MODEL : DEFAULT_SPEECH_MODEL;
  const config = configuration(options);
  const tokens = validateInteger(
    options.maxOutputTokens ?? options.maxNewTokens ?? 512,
    'maxOutputTokens',
    1,
    65_536,
  );
  let modelPath: string;
  try {
    modelPath =
      options.modelPath instanceof URL
        ? fileURLToPath(options.modelPath)
        : (options.modelPath ?? getModelPath(options.cacheDir, modelKind));
    validateText(modelPath, 'modelPath');
    if (!modelPath) throw new Error('The path is empty.');
    modelPath = resolve(modelPath);
  } catch (cause) {
    throw new NeedleError(
      'INVALID_ARGUMENT',
      'modelPath must be a local file path or a file: URL.',
      { cause },
    );
  }
  const workerData: WorkerConfig = {
    ...config,
    modelKind,
    modelPath,
    ...(options.modelPath === undefined ? { expectedSha256: artifact.sha256 } : {}),
  };
  const execArgv = process.execArgv.filter(
    (arg, index, args) =>
      !arg.startsWith('--input-type=') &&
      arg !== '--input-type' &&
      args[index - 1] !== '--input-type',
  );
  const worker = new Worker(new URL('./worker.js', import.meta.url), {
    workerData,
    env: { NEEDLE_TELEMETRY: '0', DO_NOT_TRACK: '1' },
    // Let Node inherit worker-safe options unless stdin's input type needs removing.
    // Explicitly forwarding all flags also forwards unsupported process/V8 options.
    ...(execArgv.length === process.execArgv.length ? {} : { execArgv }),
  });
  const session = new RpcSession<Tools>(
    {
      send: (request) => worker.postMessage(request),
      terminate: async () => {
        await worker.terminate();
      },
      ref: () => worker.ref(),
      unref: () => worker.unref(),
      listen(onMessage, onError) {
        worker.on('message', onMessage);
        worker.on('error', onError);
        worker.on('messageerror', onError);
        worker.once('exit', (code) => onError(new Error(`Inference worker exited (${code}).`)));
      },
    },
    tokens,
  );
  const abort = () => {
    void session.close();
  };
  options.abortSignal?.addEventListener('abort', abort, { once: true });
  try {
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
