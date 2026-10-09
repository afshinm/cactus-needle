import { Agent } from '../client.js';
import { NeedleError } from '../errors.js';
import { shortcuts } from '../shortcuts.js';
import type { Whistle as WhistleSession } from '../speech.js';
import { SpeechClient } from '../speech-client.js';
import type { ToolCollection } from '../tools.js';
import type { Needle as NeedleSession } from '../types.js';
import { readAudio } from './audio.js';
import { downloadModel } from './model.js';
import { loadSession } from './session.js';
import type { NeedleOptions, WhistleOptions } from './types.js';

export type NeedleSettings<Tools extends ToolCollection = ToolCollection> = NeedleOptions<Tools> & {
  /** Python's weights argument. modelPath remains an alias. */
  weights?: string | URL;
  /** Download missing default weights on first use. Defaults to true for this convenience API. */
  download?: boolean;
};
export type WhistleSettings = WhistleOptions & Pick<NeedleSettings, 'weights' | 'download'>;
export type Needle<Tools extends ToolCollection = ToolCollection> = NeedleSession<Tools>;
export type Whistle = WhistleSession;

async function load<Tools extends ToolCollection>(
  options: NeedleSettings<Tools>,
  model: 'needle3' | 'whistle',
  signal: AbortSignal,
) {
  signal = options.abortSignal ? AbortSignal.any([signal, options.abortSignal]) : signal;
  signal.throwIfAborted();
  if (options.weights !== undefined && options.modelPath !== undefined)
    throw new NeedleError('INVALID_ARGUMENT', 'Supply weights or modelPath, not both.');
  if (options.download !== undefined && typeof options.download !== 'boolean')
    throw new NeedleError('INVALID_ARGUMENT', 'download must be a boolean.');
  const modelPath = options.weights ?? options.modelPath;
  if (modelPath === undefined && options.download !== false)
    await downloadModel({
      model,
      signal,
      ...(options.cacheDir === undefined ? {} : { cacheDir: options.cacheDir }),
    });
  return loadSession(
    {
      ...options,
      stateless: false,
      abortSignal: signal,
      ...(modelPath === undefined ? {} : { modelPath }),
    },
    model,
  );
}

/** Familiar Python lifecycle, with lazy asynchronous loading on the first operation. */
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
