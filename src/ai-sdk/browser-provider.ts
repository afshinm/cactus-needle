import { createNeedle as createSession, createWhistle } from '../browser/session.js';
import type { BrowserNeedleOptions, BrowserWhistleOptions } from '../browser/types.js';
import { bindProvider, type NeedleProvider } from './provider.js';

export type NeedleProviderSettings = Omit<
  BrowserNeedleOptions,
  'tools' | 'stateless' | 'abortSignal'
> & {
  /** Whistle asset overrides. Text model/modelSha256 never apply to speech. */
  speech?: Omit<BrowserWhistleOptions, 'abortSignal'>;
};

/** Browser provider. Model/WASM loading and caching happen when an SDK call starts. */
export function createNeedle(options: NeedleProviderSettings = {}): NeedleProvider {
  const { speech, ...settings } = options;
  const {
    model: _model,
    modelSha256: _hash,
    system: _system,
    maxOutputTokens: _tokens,
    maxNewTokens: _legacyTokens,
    ...assets
  } = settings;
  return bindProvider(
    (request) =>
      createSession({
        ...settings,
        ...request,
        system: [options.system, request.system].filter(Boolean).join('\n'),
      }),
    (request) => createWhistle({ ...assets, ...speech, ...request }),
  );
}

export const needle: NeedleProvider = createNeedle();
