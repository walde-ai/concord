import { describe, it, expect, vi } from "vitest";

import {
  withGitHubRetry,
  isTransientGitHubFailure,
  retryDelayMs,
  createTimeoutFetch,
  GitHubRequestTimeoutError,
  DEFAULT_GITHUB_RETRY_OPTIONS,
  type GitHubRetryOptions,
} from "../src/infra/adapters/producers/github/github-retry";

const FAST_RETRY: GitHubRetryOptions = {
  maxAttempts: 4,
  initialDelayMs: 1,
  maxDelayMs: 4,
  backoffMultiplier: 2,
};

function noSleep(): (ms: number, signal: AbortSignal) => Promise<void> {
  return () => Promise.resolve();
}

function networkError(message: string, status?: number): Error {
  const error = Object.assign(new Error(message), status === undefined ? {} : { status });
  return error;
}

describe("withGitHubRetry", () => {
  it("returns the value when the first attempt succeeds without retrying", async () => {
    const operation = vi.fn().mockResolvedValue("ok");
    const result = await withGitHubRetry(operation, FAST_RETRY, undefined, { sleep: noSleep() });
    expect(result).toBe("ok");
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("retries a transient network error (ECONNREFUSED) and succeeds on a later attempt", async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce(networkError("connect ECONNREFUSED 4.208.26.200:443"))
      .mockRejectedValueOnce(networkError("getaddrinfo EAI_AGAIN api.github.com"))
      .mockResolvedValueOnce("recovered");
    const result = await withGitHubRetry(operation, FAST_RETRY, undefined, { sleep: noSleep() });
    expect(result).toBe("recovered");
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it("retries transient HTTP 5xx and 429 statuses", async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce(networkError("server error", 503))
      .mockRejectedValueOnce(networkError("rate limit", 429))
      .mockResolvedValueOnce("ok");
    const result = await withGitHubRetry(operation, FAST_RETRY, undefined, { sleep: noSleep() });
    expect(result).toBe("ok");
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it("does NOT retry a non-transient 4xx failure (e.g. 404) and surfaces it immediately", async () => {
    const notFound = networkError("Not Found", 404);
    const operation = vi.fn().mockRejectedValue(notFound);
    await expect(withGitHubRetry(operation, FAST_RETRY, undefined, { sleep: noSleep() })).rejects.toThrow("Not Found");
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("gives up after maxAttempts and rejects with the last transient error", async () => {
    const operation = vi.fn().mockRejectedValue(networkError("Connect Timeout Error", 500));
    await expect(withGitHubRetry(operation, FAST_RETRY, undefined, { sleep: noSleep() })).rejects.toThrow(
      "Connect Timeout Error",
    );
    expect(operation).toHaveBeenCalledTimes(FAST_RETRY.maxAttempts);
  });

  it("aborts immediately when the caller signal is already aborted", async () => {
    const operation = vi.fn();
    const controller = new AbortController();
    controller.abort(new Error("run timeout"));
    await expect(withGitHubRetry(operation, FAST_RETRY, controller.signal)).rejects.toThrow("run timeout");
    expect(operation).not.toHaveBeenCalled();
  });

  it("stops retrying when the caller signal aborts mid-backoff", async () => {
    const controller = new AbortController();
    const sleep = (_ms: number, signal: AbortSignal): Promise<void> => {
      controller.abort(new Error("aborted mid-run"));
      // mirror the real helper: an aborted sleep rejects with the reason
      if (signal.aborted) {
        return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
      }
      return Promise.resolve();
    };
    const operation = vi.fn().mockRejectedValueOnce(networkError("fetch failed"));
    await expect(withGitHubRetry(operation, FAST_RETRY, controller.signal, { sleep })).rejects.toThrow(
      "aborted mid-run",
    );
    expect(operation).toHaveBeenCalledTimes(1);
  });
});

describe("isTransientGitHubFailure", () => {
  it("flags the request timeout error as transient (so a stall is retried, not failed)", () => {
    expect(isTransientGitHubFailure(new GitHubRequestTimeoutError(30_000))).toBe(true);
  });

  it("walks the cause chain to find a wrapped network error", () => {
    const root = networkError("connect ECONNREFUSED");
    const wrapped = new Error("fetch failed");
    (wrapped as { cause?: unknown }).cause = root;
    expect(isTransientGitHubFailure(wrapped)).toBe(true);
  });

  it("does not flag a deterministic 4xx", () => {
    expect(isTransientGitHubFailure(networkError("Unprocessable", 422))).toBe(false);
  });
});

describe("retryDelayMs", () => {
  it("grows exponentially and caps at maxDelayMs", () => {
    const opts = DEFAULT_GITHUB_RETRY_OPTIONS;
    expect(retryDelayMs(0, opts)).toBe(opts.initialDelayMs);
    expect(retryDelayMs(1, opts)).toBe(opts.initialDelayMs * 2);
    expect(retryDelayMs(10, opts)).toBe(opts.maxDelayMs);
  });
});

describe("createTimeoutFetch", () => {
  it("passes through to the inner fetch when it completes in time", async () => {
    const inner = vi.fn().mockResolvedValue(new Response("ok"));
    const fetch = createTimeoutFetch(1_000, inner);
    await fetch("https://api.github.com/zen");
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it("aborts the inner fetch and rejects when it exceeds the timeout", async () => {
    vi.useFakeTimers();
    try {
      const inner = vi.fn().mockImplementation((_url, options) => {
        return new Promise((_resolve, reject) => {
          const signal = (options as { signal: AbortSignal }).signal;
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      });
      const fetch = createTimeoutFetch(50, inner);
      const promise = fetch("https://api.github.com/zen");
      // Attach a handler before advancing the clock so the rejection is never
      // observed as unhandled in the gap between the timer firing and the
      // assertion attaching its own handler.
      const captured = promise.then(
        () => { throw new Error("expected the stalled fetch to be rejected"); },
        (error: unknown) => error,
      );
      expect(inner).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(50);
      const reason = await captured;
      expect(reason).toBeInstanceOf(Error);
      expect((reason as Error).message).toBe("aborted");
    } finally {
      vi.useRealTimers();
    }
  });

  it("propagates an externally-supplied signal abort immediately", async () => {
    const controller = new AbortController();
    const inner = vi.fn().mockImplementation((_url, options) => {
      return new Promise((_resolve, reject) => {
        const signal = (options as { signal: AbortSignal }).signal;
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    });
    const fetch = createTimeoutFetch(10_000, inner);
    const promise = fetch("https://api.github.com/zen", { signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toThrow();
  });
});
