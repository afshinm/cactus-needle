import { createNeedle as createSession } from '../browser/session.js';
import type { BrowserNeedleOptions } from '../browser/types.js';
import { bindProvider, type NeedleProvider } from './provider.js';

export type NeedleProviderSettings = Omit<
  BrowserNeedleOptions,
  'tools' | 'stateless' | 'abortSignal'
>;

/** Browser provider. Model/WASM loading and caching happen when an SDK call starts. */
export function createNeedle(options: NeedleProviderSettings = {}): NeedleProvider {
  return bindProvider((request) =>
    createSession({
      ...options,
      ...request,
      system: [options.system, request.system].filter(Boolean).join('\n'),
    }),
  );
}

export const needle: NeedleProvider = createNeedle();
