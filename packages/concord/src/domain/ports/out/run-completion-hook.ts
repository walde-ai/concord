import type { RunState } from "../../entities/run";

/** The states a run can be in when it finishes — the only states the
 * completion hook is notified about. */
export type TerminalRunState = Extract<
  RunState,
  "SUCCEEDED" | "FAILED" | "TIMED_OUT" | "ABORTED" | "SUPERSEDED"
>;

/** What the dispatcher hands to {@link RunCompletionHook.runFinished}: the id
 * of the run that ended and the terminal state it ended in. Reclamation
 * policy is state-dependent (a succeeded run's resources go immediately; a
 * failed run's may be held for a restart), so the hook must see the
 * outcome, not just the fact of completion. */
export interface FinishedRun {
  readonly runId: string;
  readonly state: TerminalRunState;
  /** Best-effort context about the finished run for hooks that need more
   * than ids (notably the terminal-failure notifier). Optional because test
   * embeddings and simple hooks do not provide it; every field inside is
   * itself optional because event payloads differ per consumer. */
  readonly detail?: FinishedRunDetail;
}

/** The repository a finished run's event payload named, when it named one. */
export interface FinishedRunRepoRef {
  readonly owner: string;
  readonly repo: string;
}

/** What the dispatcher can extract about a finished run without knowing the
 * consumer: its id, the repo/PR its event carried (most PR-scoped payloads
 * carry both), and the recorded failure. Probed defensively off the payload
 * — never trusted. */
export interface FinishedRunDetail {
  readonly consumerId: string;
  readonly repo?: FinishedRunRepoRef;
  readonly prNumber?: number;
  readonly errorName?: string;
  readonly message?: string;
}

/**
 * A hook invoked once a run reaches a terminal state — success, failure,
 * timeout, abort, or supersession. It lets infrastructure that scopes
 * resources to a run's lifetime (notably the git worktrees agent runs check
 * out) reclaim those resources from the dispatcher's execute path, instead
 * of trusting every handler to clean up after itself on every exit path (a
 * trust that leaked 166 worktrees on the host before this hook existed).
 *
 * Contract: {@link runFinished} must never throw and must never block the
 * run's own completion for long — the dispatcher invokes it detached and
 * only logs failures. Implementations should make their own operations
 * best-effort with bounded timeouts.
 */
export interface RunCompletionHook {
  runFinished(finished: FinishedRun): Promise<void>;
}

/** Default no-op used by tests and embeddings that hold no run-scoped resources. */
export class NoOpRunCompletionHook implements RunCompletionHook {
  public async runFinished(_finished: FinishedRun): Promise<void> {
    // no resources to release
  }
}

/** Runs several completion hooks in order, isolating each one's failures so
 * a defect in one hook (the contract forbids throwing, but implementations
 * are best-effort) cannot starve the others of the terminal notification. */
export class CompositeRunCompletionHook implements RunCompletionHook {
  private readonly hooks: readonly RunCompletionHook[];

  public constructor(hooks: readonly RunCompletionHook[]) {
    this.hooks = [...hooks];
  }

  public async runFinished(finished: FinishedRun): Promise<void> {
    for (const hook of this.hooks) {
      try {
        await hook.runFinished(finished);
      } catch {
        // Swallowed deliberately: the dispatcher-level catch only sees the
        // composite as a whole, so per-hook isolation is this loop's job.
      }
    }
  }
}
