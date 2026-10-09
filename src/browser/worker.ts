import factory from 'needle-runtime';
import { errorMessage, NeedleError } from '../errors.js';
import { Engine } from '../runtime/engine.js';
import type { CompletionResult } from '../types.js';
import { loadAssets } from './assets.js';
import type { BrowserRequest, BrowserResponse } from './protocol.js';

// A structural worker interface avoids exposing WebWorker/Node ambient types to consumers.
const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<BrowserRequest>) => void) | null;
  postMessage(message: BrowserResponse, transfer?: Transferable[]): void;
  close(): void;
};
let engine: Engine | undefined;
let initializing = false;

function failure(error: unknown, id?: number): void {
  scope.postMessage({
    type: 'error',
    ...(id === undefined ? {} : { id }),
    code: error instanceof NeedleError ? error.code : 'ENGINE_ERROR',
    message: errorMessage(error),
  });
}

scope.onmessage = async ({ data: request }) => {
  if ('type' in request && request.type === 'init') {
    if (initializing) {
      failure(new NeedleError('INVALID_ARGUMENT', 'Worker already initialized.'));
      return;
    }
    initializing = true;
    try {
      const { model, wasmBinary } = await loadAssets(request.config, (progress) =>
        scope.postMessage({ type: 'progress', progress }),
      );
      // The runtime receives verified bytes. Inference has no network capability.
      globalThis.fetch = async () => {
        throw new NeedleError('ENGINE_ERROR', 'Network access is disabled during inference.');
      };
      engine = Engine.create(await factory({ wasmBinary }), request.config, model);
      scope.postMessage({ type: 'ready' });
    } catch (error) {
      failure(error);
      scope.close();
    }
    return;
  }
  if ('type' in request) return;
  try {
    if (!engine) throw new NeedleError('ENGINE_ERROR', 'Worker is not ready.');
    let value: CompletionResult | Float32Array | undefined;
    switch (request.method) {
      case 'complete':
        value = engine.complete(request.input, request.maxNewTokens);
        break;
      case 'embed':
        value = engine.embed(request.input);
        break;
      case 'reset':
        engine.reset();
        break;
      default:
        throw new NeedleError('INVALID_ARGUMENT', 'Unknown worker operation.');
    }
    scope.postMessage(
      { type: 'result', id: request.id, value },
      value instanceof Float32Array ? [value.buffer as ArrayBuffer] : [],
    );
  } catch (error) {
    failure(error, request.id);
    if (error instanceof WebAssembly.RuntimeError) {
      failure(error); // Reject other queued calls before closing the worker.
      scope.close();
    }
  }
};
