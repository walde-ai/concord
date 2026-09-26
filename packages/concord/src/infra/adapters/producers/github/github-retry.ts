import { UnexpectedStateError } from "../../../../domain/exceptions/errors";

// GitHub is reached over the public internet, and on some hosts the connection
// is intermittently unreliable: DNS hiccups (EAI_AGAIN), refused connections
// (ECONNREFUSED), connect timeouts, TCP resets, and transient HTTP 5xx / 429
// responses all show up as one-off failures that clear on the next attempt.
// Without recovery every such blip fails the caller outright — the producer
// misses a scan, a handler's review/comment never lands.
//
// This module recovers those blips: {@link withGitHubRetry} retries a single
// GitHub operation on transient failures with exponential backoff, and
// {@link createTimeoutFetch} bounds each underlying HTTP request so a connection
// that stalls mid-response (not caught by the connect timeout) is surfaced as a
// retryable failure instead of hanging until undici's far longer default.
//
// Non-transient failures (4xx other than 408/429, a caller abort) surface
// immediately so a real bug is not papered over with retries.

export interface GitHubRetryOptions {
  readonly maxAttempts: number;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly backoffMultiplier: number;
}

export const DEFAULT_GITHUB_RETRY_OPTIONS: GitHubRetryOptions = {
  maxAttempts: 4,
  initialDelayMs: 500,
  maxDelayMs: 8_000,
  backoffMultiplier: 2,
};

export const DEFAULT_GITHUB_REQUEST_TIMEOUT_MS = 30_000;

// HTTP statuses that represent a transient server-side or rate-limiting
// condition. 4xx (other than 408/429) is the request being wrong, not the
// network — retrying it cannot help and only hides a real bug, so it is
// excluded.
const TRANSIENT_HTTP_STATUSES: ReadonlySet<number> = new Set([408, 425, 429, 500, 502, 503, 504]);

// Signatures of transient transport-level failures observed against the real
// GitHub API (see concord.err.log): node fetch's generic wrapper, DNS errors,
// TCP resets/timeouts, and undici's named aborts. Matched against the full
// error cause chain so a failure wrapped several layers deep is still detected.
const TRANSIENT_NETWORK_PATTERNS: ReadonlyArray<RegExp> = [
  /fetch failed/i,
  /ECONNREFUSED/i,
  /EAI_AGAIN/i,
  /ENOTFOUND/i,
  /ECONNRESET/i,
  /EPIPE/i,
  /ETIMEDOUT/i,
  /UND_ERR/i,
  /Connect Timeout/i,
  /other side closed/i,
  /socket hang up/i,
  /network error/i,
  /This operation was aborted/i,
  /GitHub request exceeded its/i,
];

export class GitHubRequestTimeoutError extends UnexpectedStateError {
  public constructor(timeoutMs: number) {
    super(`GitHub request exceeded its ${timeoutMs}ms timeout`);
  }
}

export interface GitHubRetryDeps {
  readonly sleep?: (ms: number, signal: AbortSignal | undefined) => Promise<void>;
}

type FetchLike = (url: string, options?: Record<string, unknown>) => Promise<unknown>;

/**
 * Builds a `fetch` suitable for `new Octokit({ request: { fetch } })` that caps
 * each individual HTTP request at {@link timeoutMs}. A controller is linked to
 * the caller's own signal (when octokit forwards one) so a caller abort still
 * propagates, and the timeout aborts the real underlying fetch — freeing the
 * socket — rather than merely racing the promise.
 */
export function createTimeoutFetch(
  timeoutMs: number = DEFAULT_GITHUB_REQUEST_TIMEOUT_MS,
  inner: FetchLike = globalFetch,
): FetchLike {
  return async (url, options) => {
    const external = readSignal(options);
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new GitHubRequestTimeoutError(timeoutMs));
    }, timeoutMs);
    const onExternalAbort = (): void => {
      clearTimeout(timer);
      controller.abort(external === undefined ? undefined : external.reason);
    };
    if (external !== undefined) {
      if (external.aborted) {
        clearTimeout(timer);
        controller.abort(external.reason);
      } else {
        external.addEventListener("abort", onExternalAbort, { once: true });
      }
    }
    try {
      return await inner(url, { ...(options ?? {}), signal: controller.signal });
    } finally {
      clearTimeout(timer);
      if (external !== undefined) {
        external.removeEventListener("abort", onExternalAbort);
      }
    }
  };
}

/**
 * Executes a GitHub operation with transient-failure retry. The optional
 * {@link signal} (typically the run's AbortSignal) aborts the loop immediately
 * when the caller is no longer interested in the result.
 */
export async function withGitHubRetry<T>(
  operation: () => Promise<T>,
  options: GitHubRetryOptions,
  signal?: AbortSignal,
  deps: GitHubRetryDeps = {},
): Promise<T> {
  const sleep = deps.sleep ?? defaultSleep;
  let lastError: unknown;
  for (let attempt = 0; attempt < options.maxAttempts; attempt = attempt + 1) {
    if (signal !== undefined && signal.aborted) {
      throw abortedError(signal);
    }
    try {
      return await operation();
    } catch (cause) {
      lastError = cause;
      if (signal !== undefined && signal.aborted) {
        throw abortedError(signal);
      }
      const attemptsRemaining = attempt + 1 < options.maxAttempts;
      if (!attemptsRemaining || !isTransientGitHubFailure(cause)) {
        throw cause;
      }
      await sleep(retryDelayMs(attempt, options), signal);
    }
  }
  throw lastError;
}
export function retryDelayMs(attempt: number, options: GitHubRetryOptions): number {
  const base = options.initialDelayMs * Math.pow(options.backoffMultiplier, attempt);
  return Math.min(base, options.maxDelayMs);
}

export function isTransientGitHubFailure(cause: unknown): boolean {
  if (cause instanceof GitHubRequestTimeoutError) {
    return true;
  }
  const status = httpStatusOf(cause);
  if (status !== null && TRANSIENT_HTTP_STATUSES.has(status)) {
    return true;
  }
  return errorChainMatches(cause, TRANSIENT_NETWORK_PATTERNS);
}

function readSignal(options: Record<string, unknown> | undefined): AbortSignal | undefined {
  if (options === undefined) {
    return undefined;
  }
  const signal = (options as { signal?: unknown }).signal;
  return signal instanceof AbortSignal ? signal : undefined;
}

function globalFetch(url: string, options?: Record<string, unknown>): Promise<unknown> {
  return globalThis.fetch(url, options as RequestInit) as unknown as Promise<unknown>;
}

function httpStatusOf(cause: unknown): number | null {
  if (cause === null || typeof cause !== "object") {
    return null;
  }
  const status = (cause as { status?: unknown }).status;
  return typeof status === "number" && Number.isFinite(status) ? status : null;
}

function errorChainMatches(cause: unknown, patterns: ReadonlyArray<RegExp>): boolean {
  const seen = new Set<unknown>();
  let current: unknown = cause;
  while (current instanceof Error && !seen.has(current)) {
    const node = current;
    seen.add(node);
    if (patterns.some((pattern) => pattern.test(node.message))) {
      return true;
    }
    current = (node as { cause?: unknown }).cause;
  }
  return false;
}

function abortedError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) {
    return reason;
  }
  return new UnexpectedStateError("GitHub operation aborted");
}

const defaultSleep = (ms: number, signal: AbortSignal | undefined): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal !== undefined && signal.aborted) {
      reject(abortedError(signal));
      return;
    }
    const timer = setTimeout(resolve, ms);
    if (signal === undefined) {
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortedError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
