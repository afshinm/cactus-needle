import { readFile } from 'node:fs/promises';
import { NeedleError } from '../errors.js';
import type { ReadAudio } from '../speech-client.js';

export const readAudio: ReadAudio = async (source, signal) => {
  signal.throwIfAborted();
  if (typeof source === 'string' || source instanceof URL) {
    if (source instanceof URL && source.protocol !== 'file:')
      throw new NeedleError('INVALID_ARGUMENT', 'Node audio must be a local path or file: URL.');
    return readFile(source, { signal });
  }
  if (source instanceof Blob) return new Uint8Array(await source.arrayBuffer());
  return source;
};
