import type { Needle, SessionOptions } from '../types.js';

export type SessionFactory = (
  options: SessionOptions & { abortSignal?: AbortSignal },
) => Promise<Needle>;

/** One worker per SDK request: dynamic schemas, parallel calls and aborts stay isolated. */
export async function withSession<T>(
  load: SessionFactory,
  options: SessionOptions,
  signal: AbortSignal | undefined,
  run: (session: Needle) => Promise<T>,
): Promise<T> {
  signal?.throwIfAborted();
  const session = await load({
    ...options,
    ...(signal === undefined ? {} : { abortSignal: signal }),
  });
  const abort = () => {
    void session.close();
  };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    signal?.throwIfAborted();
    const result = await run(session);
    signal?.throwIfAborted();
    return result;
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
    await session.close();
  }
}
