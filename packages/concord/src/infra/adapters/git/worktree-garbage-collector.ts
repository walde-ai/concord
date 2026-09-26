import path from "path";

import type { GithubRepoEntry } from "../producers/github/github-repos-context";
import type { Logger } from "../../../domain/ports/out/logger";
import type { GitWorktreeManager } from "./git-worktree-manager";

const LOG_SOURCE = "worktree-gc";

/**
 * Default age threshold before an orphaned worktree becomes collectable:
 * three days. Fresh enough that an operator can inspect a recently failed
 * run's checkout; old enough that anything still sitting there after three
 * days is a genuine orphan (the incident that motivated this collector had
 * accumulated 166 worktrees over weeks).
 */
export const DEFAULT_WORKTREE_GC_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

export interface WorktreeGcSummary {
  readonly repos: number;
  readonly inspected: number;
  readonly removed: number;
  readonly stashed: number;
  readonly kept: number;
}

/**
 * Startup garbage collector for worktrees orphaned by crashes, restarts, or
 * pre-cleanup versions of Concord. Runs once, best-effort, at server startup
 * BEFORE the app starts (before `InterruptedRunReconciler` re-dispatches
 * interrupted runs) so it can never race a live run for a worktree.
 *
 * Policy (conservative by design):
 * - `git worktree prune` first: drops git's bookkeeping for worktrees whose
 *   directories are already gone.
 * - Only LINKED worktrees living UNDER the repo's configured worktrees root
 *   (`GithubRepoEntry.worktrees`, the root Concord itself creates worktrees
 *   in) are candidates. Worktrees at foreign paths (e.g. reused leaked
 *   checkouts) and the primary checkout are never touched.
 * - Only worktrees whose directory mtime is older than the age threshold are
 *   removed; removal goes through {@link GitWorktreeManager.safeRemove}, so a
 *   dirty orphan is stashed on the shared stash (recoverable) before its
 *   checkout is deleted — the collector never destroys uncommitted work.
 * - Every per-worktree failure is logged and skipped; the collector itself
 *   never throws.
 */
export class WorktreeGarbageCollector {
  public constructor(
    private readonly manager: GitWorktreeManager,
    private readonly logger: Logger,
    private readonly maxAgeMs: number = DEFAULT_WORKTREE_GC_MAX_AGE_MS,
    private readonly now: () => number = Date.now,
  ) {}

  public async collect(entries: readonly GithubRepoEntry[]): Promise<WorktreeGcSummary> {
    const summary = { repos: 0, inspected: 0, removed: 0, stashed: 0, kept: 0 };
    for (const entry of entries) {
      if (entry.local === undefined || entry.worktrees === undefined) {
        continue;
      }
      summary.repos += 1;
      try {
        await this.manager.pruneWorktrees(entry);
      } catch (cause) {
        this.logger.warn(LOG_SOURCE, "worktree prune failed", {
          repo: entry.name,
          error: describeCause(cause),
        });
      }
      let paths: readonly string[];
      try {
        paths = await this.manager.listWorktreePaths(entry);
      } catch (cause) {
        this.logger.warn(LOG_SOURCE, "could not list worktrees; skipping repo", {
          repo: entry.name,
          error: describeCause(cause),
        });
        continue;
      }
      const root = path.resolve(entry.worktrees);
      const primary = path.resolve(entry.local);
      const fs = await import("fs");
      for (const candidate of paths) {
        const target = path.resolve(candidate);
        if (target === primary || !isUnder(target, root)) {
          continue;
        }
        summary.inspected += 1;
        const ageMs = await this.ageOf(target, fs);
        if (ageMs === null) {
          summary.kept += 1;
          continue;
        }
        if (ageMs < this.maxAgeMs) {
          summary.kept += 1;
          continue;
        }
        const outcome = await this.manager.safeRemove(
          target,
          `startup garbage collection (worktree ${Math.floor(ageMs / 86_400_000)}d old)`,
        );
        if (outcome.status === "removed") {
          summary.removed += 1;
          if (outcome.stashed) {
            summary.stashed += 1;
          }
          this.logger.info(LOG_SOURCE, "collected orphaned worktree", {
            repo: entry.name,
            worktreePath: target,
            stashed: outcome.stashed,
          });
        } else if (outcome.status === "skipped") {
          summary.kept += 1;
          this.logger.warn(LOG_SOURCE, "kept orphaned worktree", {
            repo: entry.name,
            worktreePath: target,
            reason: outcome.reason,
          });
        }
      }
    }
    return summary;
  }

  private async ageOf(target: string, fs: typeof import("fs")): Promise<number | null> {
    try {
      const stats = await fs.promises.stat(target);
      return this.now() - stats.mtimeMs;
    } catch {
      // Listed by git but already gone on disk; prune will have handled it or
      // will on the next run. Nothing to remove.
      return null;
    }
  }
}

function isUnder(target: string, root: string): boolean {
  if (target === root) {
    return false;
  }
  return target.startsWith(root + path.sep);
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
