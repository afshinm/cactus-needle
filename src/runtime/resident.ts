import { NeedleError } from '../errors.js';

/** Owns lazy loading and serializes whole operations, including multi-step tool runs. */
export abstract class Resident<Session extends { close(): Promise<void> }> {
  readonly #lifetime = new AbortController();
  #session: Promise<Session> | undefined;
  #tail: Promise<unknown> = Promise.resolve();
  #closing: Promise<void> | undefined;

  constructor(private readonly load: (signal: AbortSignal) => Promise<Session>) {}

  protected assertOpen(): void {
    this.#lifetime.signal.throwIfAborted();
  }

  protected use<T>(
    run: (session: Session, signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.#lifetime.signal.aborted) return Promise.reject(this.#lifetime.signal.reason);
    const cancel = () => {
      void this.close();
    };
    signal?.addEventListener('abort', cancel, { once: true });
    const stopped = this.#lifetime.signal;
    let rejectClosed!: (reason: unknown) => void;
    const closed = new Promise<never>((_resolve, reject) => {
      rejectClosed = reject;
    });
    const onClose = () => rejectClosed(signal?.aborted ? signal.reason : stopped.reason);
    stopped.addEventListener('abort', onClose, { once: true });
    const operation = this.#tail.then(async () => {
      stopped.throwIfAborted();
      if (!this.#session) {
        this.#session = this.load(stopped).catch((error) => {
          this.#session = undefined;
          throw error;
        });
      }
      const session = await this.#session;
      stopped.throwIfAborted();
      const result = await run(session, stopped);
      stopped.throwIfAborted();
      return result;
    });
    this.#tail = operation.catch(() => {});
    return Promise.race([operation, closed]).finally(() => {
      signal?.removeEventListener('abort', cancel);
      stopped.removeEventListener('abort', onClose);
    });
  }

  /** Eager factories return a ready model or dispose of a failed initialization. */
  async ready(signal?: AbortSignal): Promise<this> {
    try {
      await this.use(async () => {}, signal);
      return this;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  close(): Promise<void> {
    if (!this.#closing) {
      this.#lifetime.abort(new NeedleError('CLOSED', 'This model session was closed.'));
      this.#closing =
        this.#session?.then(
          (session) => session.close(),
          () => {},
        ) ?? Promise.resolve();
    }
    return this.#closing;
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
}
