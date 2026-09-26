import type { RunCompletionHook, FinishedRun } from "../../../domain/ports/out/run-completion-hook";
import type { WorktreeManager } from "../../../domain/ports/out/worktree-manager";
import type { Logger } from "../../../domain/ports/out/logger";
import { UnexpectedStateError } from "../../../domain/exceptions/errors";

const LOG_SOURCE = "worktree-cleanup";

/**
 * How long the worktree of a run that ended in a failure state (failure,
 * timeout, abort, supersession) is kept after the run ends, so that a
 * re-started run can pick the work up where it left off instead of ditching
 * it completely (operator decision, concord#21, 2026-08-24: "for failure
 * states we want to hold them for a while (say 48 hours)").
 */
export const DEFAULT_FAILED_WORKTREE_HOLD_MS = 48 * 60 * 60 * 1000;

/**
 * How long the worktree of a SUCCEEDED run's last owner is kept after the
 * run ends before reclamation (concord#24). The successor run in the same
 * event chain (a run following another run's PR-missing event) resolves, fetches, and
 * re-tracks the SAME worktree for a measurable window before its track()
 * call lands — observed ~14s in production — and the predecessor's
 * completion hook could otherwise delete the path inside that window,
 * leaving the successor spawning agent servers into a deleted directory.
 * The grace is re-checked at fire time: if any owner, handoff, or restart
 * hold governs the path by then, the removal is dropped, not just delayed.
 */
export const DEFAULT_SUCCEEDED_REMOVAL_GRACE_MS = 60_000;

/** Schedules a deferred callback, returning its cancel. Injectable so tests
 * drive grace timers deterministically; the default uses an unref'd timer so
 * a pending removal never keeps the process alive on shutdown. */
export type RemovalScheduler = (delayMs: number, fire: () => void) => () => void;

const realRemovalScheduler: RemovalScheduler = (delayMs, fire) => {
  const timer = setTimeout(fire, delayMs);
  timer.unref?.();
  return () => clearTimeout(timer);
};

/**
 * The run-scoped lease bookkeeping every agent run's worktree is registered
 * against. Consumers of this interface live inside handlers and the task
 * runner; the reclamation side is {@link WorktreeLeaseRegistry.runFinished},
 * driven by the dispatcher when a run reaches a terminal state.
 */
export interface WorktreeLeases {
  /** Registers that {@link runId} now owns the worktree at {@link worktreePath}.
   * Idempotent per (run, path) pair; several runs may share one path (the
   * same PR branch checked out by concurrent consumers) — the worktree is
   * only reclaimable when the last owner finishes.
   *
   * A path with no current owners may still carry a stale handoff mark or a
   * restart hold from an earlier run at the same deterministic path; both
   * are cleared here, because the new run's own lifecycle now governs the
   * path. A mark on a currently-owned path is never cleared — a live
   * emitting run may still depend on it. */
  track(runId: string, worktreePath: string): void;
  /** Marks the worktree as handed off to a FUTURE run via an event payload
   * (a PR-missing event carrying the path to the publishing consumer). When
   * the current run finishes, the worktree is deliberately kept so the future
   * run can use it; the publishing run removes it itself once it has published. */
  handoff(worktreePath: string): void;
}

/** A worktree kept after its run ended in a failure state, until the restart
 * hold expires. */
interface RestartHold {
  /** The run whose failure recorded the hold (for logging). */
  readonly runId: string;
  readonly heldUntilMs: number;
}

/**
 * In-memory registry pairing runs to the worktrees they checked out, and the
 * {@link RunCompletionHook} that reclaims those worktrees when runs end.
 *
 * Why a registry at all: worktrees are created deep inside handler flows
 * (`AgentTaskRunner`), while the point that observes every handler-executed
 * run's terminal transition — success, failure, timeout, abort, supersession
 * — is the `RunDispatcher`. The registry bridges the two without the domain
 * knowing anything about git: handlers track paths keyed by run id, the
 * dispatcher calls {@link runFinished} once per terminal run.
 *
 * Reclamation policy (documented, deliberately conservative):
 * - Removal goes through {@link WorktreeManager.safeRemove}: uncommitted work
 *   is stashed on the repo's shared stash first, so nothing is ever lost.
 * - A path shared by several live runs is removed only when the last one ends.
 * - A path marked as {@link handoff handed off} is never removed here; the
 *   receiving run owns its lifetime from that point. (Should that run never
 *   happen, the startup garbage collector reclaims the worktree once it is
 *   older than its age threshold.)
 * - A SUCCEEDED run's unclaimed worktrees are safe-removed immediately.
 * - A run that ends in a failure state (failure, timeout, abort,
 *   supersession) has its unclaimed worktrees HELD for
 *   {@link DEFAULT_FAILED_WORKTREE_HOLD_MS}, so a re-started run on the same
 *   branch picks the work up where it left off (concord#21). The hold is
 *   dropped when another run re-tracks the path; once it expires, the next
 *   run completion sweeps the worktree away (and the startup garbage
 *   collector is the backstop on an idle server).
 * - Registry contents are in-memory only: after a process restart the map is
 *   empty and surviving worktrees are orphans by definition, again left to
 *   the startup garbage collector.
 * - Every cleanup failure is logged and swallowed: a worktree that refuses
 *   removal must never fail the run it belonged to.
 */
export class WorktreeLeaseRegistry implements WorktreeLeases, RunCompletionHook {
  private readonly runs = new Map<string, Set<string>>();
  private readonly owners = new Map<string, number>();
  private readonly handedOff = new Set<string>();
  private readonly restartHolds = new Map<string, RestartHold>();
  private readonly pendingRemovals = new Map<string, PendingRemoval>();

  public constructor(
    private readonly worktreeManager: WorktreeManager,
    private readonly logger: Logger,
    private readonly failedRunHoldMs: number = DEFAULT_FAILED_WORKTREE_HOLD_MS,
    private readonly now: () => number = Date.now,
    private readonly succeededRemovalGraceMs: number = DEFAULT_SUCCEEDED_REMOVAL_GRACE_MS,
    private readonly scheduler: RemovalScheduler = realRemovalScheduler,
  ) {}

  public track(runId: string, worktreePath: string): void {
    let paths = this.runs.get(runId);
    if (paths === undefined) {
      paths = new Set<string>();
      this.runs.set(runId, paths);
    }
    if (paths.has(worktreePath)) {
      return;
    }
    paths.add(worktreePath);
    const currentOwners = this.owners.get(worktreePath) ?? 0;
    if (currentOwners === 0) {
      // No live owner: anything the path still carries from an earlier run
      // at this deterministic path is stale by definition. A handoff mark
      // whose receiving lifecycle is over would otherwise suppress this
      // run's reclamation forever (worktree paths are per-branch and PR head
      // branches are reused across runs); a restart hold is moot once a new
      // run owns the path.
      this.handedOff.delete(worktreePath);
      this.restartHolds.delete(worktreePath);
      // A pending deferred removal for this path is now moot as well: a live
      // run owns the path again. The fire-time check would skip it anyway;
      // cancelling here keeps the map honest for logging and tests.
      const pending = this.pendingRemovals.get(worktreePath);
      if (pending !== undefined) {
        pending.cancel();
        this.pendingRemovals.delete(worktreePath);
        this.logger.info(LOG_SOURCE, "deferred worktree removal cancelled; a new run owns the path", {
          worktreePath,
          pendingRemovalOfRun: pending.runId,
        });
      }
    }
    this.owners.set(worktreePath, currentOwners + 1);
  }

  public handoff(worktreePath: string): void {
    this.handedOff.add(worktreePath);
  }

  public async runFinished(finished: FinishedRun): Promise<void> {
    const paths = this.runs.get(finished.runId);
    if (paths !== undefined) {
      this.runs.delete(finished.runId);
      for (const worktreePath of paths) {
        const remaining = (this.owners.get(worktreePath) ?? 1) - 1;
        if (remaining > 0) {
          this.owners.set(worktreePath, remaining);
          continue;
        }
        this.owners.delete(worktreePath);
        if (this.handedOff.has(worktreePath)) {
          this.logger.info(LOG_SOURCE, "worktree handed off to a future run; keeping it", {
            runId: finished.runId,
            worktreePath,
          });
          continue;
        }
        if (holdsForRestart(finished)) {
          if (!(await this.worktreeManager.exists(worktreePath))) {
            // The path is already gone (e.g. reclaimed out-of-band): a hold
            // would be a ghost entry nothing can ever release against.
            this.logger.info(LOG_SOURCE, "worktree already absent while recording restart hold; nothing to hold", {
              runId: finished.runId,
              runState: finished.state,
              worktreePath,
            });
            continue;
          }
          this.restartHolds.set(worktreePath, {
            runId: finished.runId,
            heldUntilMs: this.now() + this.failedRunHoldMs,
          });
          this.logger.info(LOG_SOURCE, "holding worktree of failed run for a possible restart", {
            runId: finished.runId,
            runState: finished.state,
            worktreePath,
            holdMs: this.failedRunHoldMs,
          });
          continue;
        }
        this.deferRemoval(worktreePath, finished.runId);
      }
    }
    await this.sweepExpiredHolds();
  }

  /** Schedules the last-owner-succeeded reclamation after the grace window
   * (concord#24). Exactly one deferred removal per path: a newer one
   * replaces (and cancels) an older one. The fire-time state decides —
   * owners, handoffs, and holds all win over the removal. */
  private deferRemoval(worktreePath: string, runId: string): void {
    const existing = this.pendingRemovals.get(worktreePath);
    if (existing !== undefined) {
      existing.cancel();
    }
    const cancel = this.scheduler(this.succeededRemovalGraceMs, () => {
      this.pendingRemovals.delete(worktreePath);
      void this.fireDeferredRemoval(worktreePath, runId).catch((cause: unknown) => {
        this.logger.warn(LOG_SOURCE, "deferred worktree removal failed", {
          worktreePath,
          runId,
          error: cause instanceof Error ? cause.message : String(cause),
        });
      });
    });
    this.pendingRemovals.set(worktreePath, { runId, cancel });
    this.logger.info(LOG_SOURCE, "deferring worktree removal of succeeded run (grace for successor runs)", {
      worktreePath,
      runId,
      graceMs: this.succeededRemovalGraceMs,
    });
  }

  private async fireDeferredRemoval(worktreePath: string, runId: string): Promise<void> {
    if ((this.owners.get(worktreePath) ?? 0) > 0 || this.handedOff.has(worktreePath) || this.restartHolds.has(worktreePath)) {
      this.logger.info(LOG_SOURCE, "deferred worktree removal skipped; the worktree is back in use", {
        worktreePath,
        deferredForRun: runId,
      });
      return;
    }
    await this.removeNow(worktreePath, `grace elapsed after run ${runId} succeeded`);
  }

  /** Reclaims worktrees whose restart hold has expired. Runs as a guest of
   * every run completion — the registry has no timer of its own; the startup
   * garbage collector backstops an idle server. */
  private async sweepExpiredHolds(): Promise<void> {
    const nowMs = this.now();
    for (const [worktreePath, hold] of this.restartHolds) {
      if (nowMs < hold.heldUntilMs) {
        continue;
      }
      this.restartHolds.delete(worktreePath);
      if ((this.owners.get(worktreePath) ?? 0) > 0 || this.handedOff.has(worktreePath)) {
        // Defensive: a live owner or handoff governs the path now (track
        // already cleared the hold in every reachable flow).
        continue;
      }
      await this.removeNow(worktreePath, `restart hold of failed run ${hold.runId} expired`);
    }
  }

  private async removeNow(worktreePath: string, note: string): Promise<void> {
    const outcome = await this.worktreeManager.safeRemove(worktreePath, note);
    if (outcome.status === "removed") {
      this.logger.info(LOG_SOURCE, "removed worktree of finished run", {
        worktreePath,
        stashed: outcome.stashed,
        note,
      });
    } else if (outcome.status === "skipped") {
      this.logger.warn(LOG_SOURCE, "kept worktree of finished run", {
        worktreePath,
        reason: outcome.reason,
        note,
      });
    }
    // "absent": nothing to reclaim (e.g. removed out-of-band); stay quiet.
  }
}

/** The caveated approval policy (concord#21): succeeded runs give their
 * worktrees up immediately; runs that ended in a failure state hold them for
 * a restart. */
function holdsForRestart(finished: FinishedRun): boolean {
  if (finished.state === "SUCCEEDED") {
    return false;
  }
  if (
    finished.state === "FAILED" ||
    finished.state === "TIMED_OUT" ||
    finished.state === "ABORTED" ||
    finished.state === "SUPERSEDED"
  ) {
    return true;
  }
  throw new UnexpectedStateError(`no worktree hold policy for terminal run state ${String(finished.state)}`);
}

/** One scheduled post-grace reclamation. */
interface PendingRemoval {
  readonly runId: string;
  readonly cancel: () => void;
}
