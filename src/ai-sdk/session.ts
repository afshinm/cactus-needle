import type { Whistle } from '../speech.js';
import type { Needle, SessionOptions } from '../types.js';

export type SessionFactory<Session = Needle, Options = SessionOptions> = (
  options: Options & { abortSignal?: AbortSignal },
) => Promise<Session>;

export type WhistleFactory = SessionFactory<Whistle, Record<never, never>>;

/** One worker per SDK request: dynamic schemas, parallel calls and aborts stay isolated. */
export async function withSession<
  T,
  Session extends { close(): Promise<void> },
  Options extends object,
>(
  load: SessionFactory<Session, Options>,
  options: Options,
  signal: AbortSignal | undefined,
  run: (session: Session) => Promise<T>,
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
