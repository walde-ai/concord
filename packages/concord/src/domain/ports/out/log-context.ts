/**
 * Stable field keys under which the run/event enrichment is merged into a
 * {@link LogEntry}'s `fields` bag. Keeping them as named constants avoids the
 * string-typed typos that previously left `eventId`/`runId` off some log lines,
 * and gives the persistence layer single, well-known keys to extract for
 * indexing.
 */
export const LOG_FIELD_EVENT_ID = "eventId";
export const LOG_FIELD_RUN_ID = "runId";
export const LOG_FIELD_CONSUMER_ID = "consumerId";

/**
 * Cross-cutting enrichment attached to every log line emitted while a context is
 * active. The fields are all optional: a context created for a run carries
 * `eventId`/`runId`/`consumerId`, but the same mechanism can carry a lighter
 * context (for example just a `producerId`) where only part of the pipeline is
 * in scope.
 */
export interface LogContext {
  readonly eventId?: string;
  readonly runId?: string;
  readonly consumerId?: string;
}

/**
 * Propagates a {@link LogContext} across asynchronous boundaries so that every
 * logger sharing the same scope instance emits the active context's fields
 * without each call site having to thread the identifiers through manually.
 *
 * The scope is set explicitly by whoever owns a unit of work (the run
 * dispatcher, for a run) via {@link LogContextScope.run}, and read by the logger
 * via {@link LogContextScope.active}. There is no implicit default context: when
 * nothing is active, `active()` returns an empty context and logs are emitted
 * unchanged.
 */
export interface LogContextScope {
  active(): LogContext;
  run<T>(context: LogContext, fn: () => Promise<T>): Promise<T>;
}

export const noopLogContextScope: LogContextScope = {
  active: () => ({}),
  run: (_context, fn) => fn(),
};
