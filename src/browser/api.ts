import { Agent } from '../client.js';
import { NeedleError } from '../errors.js';
import { shortcuts } from '../shortcuts.js';
import type { Whistle as WhistleSession } from '../speech.js';
import { SpeechClient } from '../speech-client.js';
import type { ToolCollection } from '../tools.js';
import type { Needle as NeedleSession } from '../types.js';
import { readAudio } from './audio.js';
import { loadSession } from './session.js';
import type { BrowserNeedleOptions, BrowserWhistleOptions } from './types.js';

export type NeedleSettings<Tools extends ToolCollection = ToolCollection> =
  BrowserNeedleOptions<Tools> & {
    /** Python's weights argument. model remains an alias in browsers. */
    weights?: BrowserNeedleOptions['model'];
  };
export type WhistleSettings = BrowserWhistleOptions & Pick<NeedleSettings, 'weights'>;
export type Needle<Tools extends ToolCollection = ToolCollection> = NeedleSession<Tools>;
export type Whistle = WhistleSession;

function load<Tools extends ToolCollection>(
  options: NeedleSettings<Tools>,
  modelKind: 'needle3' | 'whistle',
  signal: AbortSignal,
) {
  if (options.weights !== undefined && options.model !== undefined)
    throw new NeedleError('INVALID_ARGUMENT', 'Supply weights or model, not both.');
  return loadSession(
    {
      ...options,
      stateless: false,
      abortSignal: options.abortSignal ? AbortSignal.any([signal, options.abortSignal]) : signal,
      ...(options.weights === undefined ? {} : { model: options.weights }),
    },
    modelKind,
  );
}

export const Needle: {
  new <const Tools extends ToolCollection = ToolCollection>(
    options?: NeedleSettings<Tools>,
  ): Needle<Tools>;
} = class extends Agent {
  constructor(options: NeedleSettings = {}) {
    super((signal) => load(options, 'needle3', signal), options);
  }
};

export const Whistle: { new (options?: WhistleSettings): Whistle } = class extends SpeechClient {
  constructor(options: WhistleSettings = {}) {
    super((signal) => load(options, 'whistle', signal), readAudio);
  }
};

export const { transcribe, stream, extract, close } = shortcuts(
  (options?: NeedleSettings) => new Needle(options),
  (options?: WhistleSettings) => new Whistle(options),
);
