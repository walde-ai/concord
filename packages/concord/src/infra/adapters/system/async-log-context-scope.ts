import { AsyncLocalStorage } from "node:async_hooks";
import type { LogContext, LogContextScope } from "../../../domain/ports/out/log-context";

/**
 * {@link LogContextScope} backed by Node's {@link AsyncLocalStorage}. The store
 * is held on the instance, so every component that shares this same instance
 * (the run dispatcher that sets the context and the logger that reads it) sees a
 * consistent, per-async-chain context. Concurrent runs each get their own
 * context because `AsyncLocalStorage.run` isolates the store per async chain.
 */
export class AsyncLogContextScope implements LogContextScope {
  private readonly storage = new AsyncLocalStorage<LogContext>();

  public active(): LogContext {
    const store = this.storage.getStore();
    return store ?? {};
  }

  public run<T>(context: LogContext, fn: () => Promise<T>): Promise<T> {
    return this.storage.run(context, fn);
  }
}
