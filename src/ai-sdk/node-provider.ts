import { createNeedle as createSession, createWhistle } from '../node/session.js';
import type { NeedleOptions, WhistleOptions } from '../node/types.js';
import { bindProvider, type NeedleProvider } from './provider.js';

export type NeedleProviderSettings = Omit<NeedleOptions, 'tools' | 'stateless' | 'abortSignal'> & {
  /** Whistle weights and loading options. Text modelPath never applies to speech. */
  speech?: Omit<WhistleOptions, 'abortSignal'>;
};

/** Local Node.js provider. Provision weights with downloadModel() or modelPath. */
export function createNeedle(options: NeedleProviderSettings = {}): NeedleProvider {
  const { speech, ...settings } = options;
  return bindProvider(
    (request) =>
      createSession({
        ...settings,
        ...request,
        system: [options.system, request.system].filter(Boolean).join('\n'),
      }),
    (request) =>
      createWhistle({
        ...(settings.cacheDir === undefined ? {} : { cacheDir: settings.cacheDir }),
        ...(settings.bufferSize === undefined ? {} : { bufferSize: settings.bufferSize }),
        ...speech,
        ...request,
      }),
  );
}

export const needle: NeedleProvider = createNeedle();
