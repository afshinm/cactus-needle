import { parentPort, workerData } from 'node:worker_threads';
import { errorMessage, NeedleError } from '../errors.js';
import type { Request, Response } from '../runtime/protocol.js';
import type { CompletionResult } from '../types.js';
import { loadNodeEngine } from './engine.js';
import type { WorkerConfig } from './protocol.js';

const port = parentPort;
if (!port) throw new Error('Needle inference must run inside its worker.');

// The pinned WASM has no network imports, and its bytes are supplied locally.
// Refuse accidental fetches in the glue code as an additional offline guard.
globalThis.fetch = async () => {
  throw new NeedleError('ENGINE_ERROR', 'Network access is disabled during inference.');
};

function failure(error: unknown, id?: number): Response {
  return {
    type: 'error',
    ...(id === undefined ? {} : { id }),
    code: error instanceof NeedleError ? error.code : 'ENGINE_ERROR',
    message: errorMessage(error),
  };
}

try {
  const engine = await loadNodeEngine(workerData as WorkerConfig);
  port.on('message', (request: Request) => {
    try {
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
      const response: Response = { type: 'result', id: request.id, value };
      port.postMessage(
        response,
        value instanceof Float32Array ? [value.buffer as ArrayBuffer] : [],
      );
    } catch (error) {
      port.postMessage(failure(error, request.id));
      if (error instanceof WebAssembly.RuntimeError) port.close();
    }
  });
  port.postMessage({ type: 'ready' } satisfies Response);
} catch (error) {
  port.postMessage(failure(error));
  port.close();
}
