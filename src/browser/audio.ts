import { NeedleError } from '../errors.js';
import type { ReadAudio } from '../speech-client.js';

export const readAudio: ReadAudio = async (source, signal) => {
  signal.throwIfAborted();
  if (typeof source === 'string' || source instanceof URL) {
    const response = await fetch(source, { signal });
    if (!response.ok)
      throw new NeedleError('DOWNLOAD_FAILED', `Audio download failed: HTTP ${response.status}.`);
    return new Uint8Array(await response.arrayBuffer());
  }
  if (source instanceof Blob) return new Uint8Array(await source.arrayBuffer());
  return source;
};
