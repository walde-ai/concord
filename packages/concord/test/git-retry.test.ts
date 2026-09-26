import { describe, it, expect, vi } from "vitest";

import {
  withGitRetry,
  isTransientGitFailure,
  retryDelayMs,
  DEFAULT_GIT_RETRY_OPTIONS,
  type GitRetryOptions,
} from "../src/infra/adapters/git/git-retry";

const FAST_RETRY: GitRetryOptions = {
  maxAttempts: 4,
  initialDelayMs: 1,
  maxDelayMs: 4,
  backoffMultiplier: 2,
};

function noSleep(): (ms: number, signal: AbortSignal) => Promise<void> {
  return () => Promise.resolve();
}

// The exact error text ChildProcessGitRunner produces for the real transient
// failures observed in concord.db (git fetch failing to reach github.com).
function gitFetchNetworkError(): Error {
  return new Error(
    "git fetch origin main exited with 128: fatal: unable to access " +
      "'https://github.com/example-corp/app.git/': Failed to connect to " +
      "github.com port 443 after 1043 ms: Could not connect to server",
  );
}

describe("withGitRetry", () => {
  it("returns the value when the first attempt succeeds without retrying", async () => {
    const operation = vi.fn().mockResolvedValue("ok");
    const result = await withGitRetry(operation, FAST_RETRY, undefined, { sleep: noSleep() });
    expect(result).toBe("ok");
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("retries a transient git fetch network error and succeeds on a later attempt", async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce(gitFetchNetworkError())
      .mockRejectedValueOnce(new Error("fatal: unable to access '...': Could not resolve host: github.com"))
      .mockResolvedValueOnce(undefined);
    await withGitRetry(operation, FAST_RETRY, undefined, { sleep: noSleep() });
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it("retries a per-command timeout (stalled connection) as a transient failure", async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new Error("git fetch origin main exceeded its 60000ms timeout"))
      .mockResolvedValueOnce(undefined);
    await withGitRetry(operation, FAST_RETRY, undefined, { sleep: noSleep() });
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry a deterministic failure (missing remote ref) and surfaces it immediately", async () => {
    const missing = new Error("git fetch origin some-ref exited with 128: fatal: couldn't find remote ref some-ref");
    const operation = vi.fn().mockRejectedValue(missing);
    await expect(withGitRetry(operation, FAST_RETRY, undefined, { sleep: noSleep() })).rejects.toThrow(
      "couldn't find remote ref",
    );
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry a 'branch already used by worktree' conflict", async () => {
    const conflict = new Error(
      "git worktree add ... exited with 128: fatal: 'fix/x' is already used by worktree at '/tmp/other'",
    );
    const operation = vi.fn().mockRejectedValue(conflict);
    await expect(withGitRetry(operation, FAST_RETRY, undefined, { sleep: noSleep() })).rejects.toThrow(
      "already used by worktree",
    );
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("gives up after maxAttempts and rejects with the last transient error", async () => {
    const operation = vi.fn().mockRejectedValue(gitFetchNetworkError());
    await expect(withGitRetry(operation, FAST_RETRY, undefined, { sleep: noSleep() })).rejects.toThrow(
      "Failed to connect to github.com",
    );
    expect(operation).toHaveBeenCalledTimes(FAST_RETRY.maxAttempts);
  });

  it("aborts immediately when the caller signal is already aborted", async () => {
    const operation = vi.fn();
    const controller = new AbortController();
    controller.abort(new Error("run timeout"));
    await expect(withGitRetry(operation, FAST_RETRY, controller.signal)).rejects.toThrow("run timeout");
    expect(operation).not.toHaveBeenCalled();
  });

  it("stops retrying when the caller signal aborts mid-backoff", async () => {
    const controller = new AbortController();
    const sleep = (_ms: number, signal: AbortSignal): Promise<void> => {
      controller.abort(new Error("aborted mid-run"));
      if (signal.aborted) {
        return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
      }
      return Promise.resolve();
    };
    const operation = vi.fn().mockRejectedValueOnce(gitFetchNetworkError());
    await expect(withGitRetry(operation, FAST_RETRY, controller.signal, { sleep })).rejects.toThrow("aborted mid-run");
    expect(operation).toHaveBeenCalledTimes(1);
  });
});

describe("isTransientGitFailure", () => {
  it("flags the real 'Failed to connect to github.com' fetch failure as transient", () => {
    expect(isTransientGitFailure(gitFetchNetworkError())).toBe(true);
  });

  it("flags a connection timeout, RPC failure, and 'remote end hung up' as transient", () => {
    expect(isTransientGitFailure(new Error("fatal: unable to access: Connection timed out"))).toBe(true);
    expect(isTransientGitFailure(new Error("error: RPC failed; curl 56 Recv failure"))).toBe(true);
    expect(isTransientGitFailure(new Error("fatal: the remote end hung up unexpectedly"))).toBe(true);
  });

  it("does not flag a missing remote ref", () => {
    expect(isTransientGitFailure(new Error("fatal: couldn't find remote ref x"))).toBe(false);
  });

  it("does not flag a worktree branch conflict", () => {
    expect(isTransientGitFailure(new Error("fatal: 'x' is already used by worktree at '/p'"))).toBe(false);
  });
});

describe("retryDelayMs", () => {
  it("grows exponentially and caps at maxDelayMs", () => {
    const opts = DEFAULT_GIT_RETRY_OPTIONS;
    expect(retryDelayMs(0, opts)).toBe(opts.initialDelayMs);
    expect(retryDelayMs(1, opts)).toBe(opts.initialDelayMs * 2);
    expect(retryDelayMs(10, opts)).toBe(opts.maxDelayMs);
  });
});
