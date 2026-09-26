import { UnexpectedStateError } from "../../../domain/exceptions/errors";

// The git remote (origin) is reached over the public internet from the same
// intermittently unreliable host that affects the GitHub API (see
// github-retry.ts): a `git fetch` / `git ls-remote` can fail with a transient
// DNS, TCP, or "could not connect" error that clears on the next attempt.
//
// After commit 982d2b0 every git command is bounded by a per-command timeout,
// so a stalled connection surfaces as a failure instead of hanging the run
// until its 1h AbortSignal. That fix turned the old silent 1h timeouts into
// fast failures — but the failure was never retried, so a single blip failed
// the whole run outright, e.g. three real runs in concord.db failed with:
//
//   git fetch origin main exited with 128: fatal: unable to access
//   'https://github.com/example-corp/app.git/': Failed to connect to
//   github.com port 443 after 1043 ms: Could not connect to server
//
// Retrying the same run by hand usually succeeds (the network has recovered),
// but that does not scale. This module recovers those blips exactly the way
// {@link withGitHubRetry} does for octokit: retry transient failures with
// exponential backoff, and surface non-transient failures (a missing remote
// ref, a "branch already used by worktree", a caller abort) immediately so a
// real problem is never papered over with retries.

export interface GitRetryOptions {
  readonly maxAttempts: number;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly backoffMultiplier: number;
}

export const DEFAULT_GIT_RETRY_OPTIONS: GitRetryOptions = {
  maxAttempts: 4,
  initialDelayMs: 1_000,
  maxDelayMs: 16_000,
  backoffMultiplier: 2,
};

// Signatures of transient transport-level failures git emits (on its stderr,
// which ChildProcessGitRunner embeds in the thrown Error message) when the
// connection to the remote is unreliable: DNS hiccups, refused/reset/timed-out
// TCP connections, accepted-then-stalled fetches (surfaced as a per-command
// timeout by ChildProcessGitRunner), and git's own "remote end hung up" / RPC
// failures. None of these say anything about the correctness of the request,
// so retrying is always safe.
const TRANSIENT_GIT_PATTERNS: ReadonlyArray<RegExp> = [
  /exceeded its \d+ms timeout/i,
  /Could not connect to server/i,
  /Failed to connect to [^\s]+ port \d+/i,
  /Could not resolve host/i,
  /Connection timed out/i,
  /Connection reset/i,
  /Connection refused/i,
  /unable to access/i,
  /the remote end hung up unexpectedly/i,
  /RPC failed/i,
  /early EOF/i,
  /fetch failed/i,
];

export interface GitRetryDeps {
  readonly sleep?: (ms: number, signal: AbortSignal | undefined) => Promise<void>;
}

/**
 * Executes a git operation with transient-failure retry. The optional
 * {@link signal} (typically the run's AbortSignal) aborts the loop immediately
 * when the caller is no longer interested in the result — both between attempts
 * and during the backoff sleep.
 */
export async function withGitRetry<T>(
  operation: () => Promise<T>,
  options: GitRetryOptions,
  signal?: AbortSignal,
  deps: GitRetryDeps = {},
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
      if (!attemptsRemaining || !isTransientGitFailure(cause)) {
        throw cause;
      }
      await sleep(retryDelayMs(attempt, options), signal);
    }
  }
  throw lastError;
}

export function retryDelayMs(attempt: number, options: GitRetryOptions): number {
  const base = options.initialDelayMs * Math.pow(options.backoffMultiplier, attempt);
  return Math.min(base, options.maxDelayMs);
}

export function isTransientGitFailure(cause: unknown): boolean {
  if (cause instanceof Error) {
    return TRANSIENT_GIT_PATTERNS.some((pattern) => pattern.test(cause.message));
  }
  return false;
}

function abortedError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) {
    return reason;
  }
  return new UnexpectedStateError("Git operation aborted");
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
