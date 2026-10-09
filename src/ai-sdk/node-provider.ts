import { createNeedle as createSession } from '../node/session.js';
import type { NeedleOptions } from '../node/types.js';
import { bindProvider, type NeedleProvider } from './provider.js';

export type NeedleProviderSettings = Omit<NeedleOptions, 'tools' | 'stateless' | 'abortSignal'>;

/** Local Node.js provider. Provision weights with downloadModel() or modelPath. */
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
