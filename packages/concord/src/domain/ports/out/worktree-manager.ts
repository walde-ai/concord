import type { GithubRepoEntry } from "../../../infra/adapters/producers/github/github-repos-context";

// Options threaded from a run's handler into the git operations it performs.
// The signal lets a run's timeout (or manual abort) interrupt a git operation
// in flight; the timeout caps any single command so a stalled network
// connection to the git remote cannot hang the run until that timeout.
export interface WorktreeOperationOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

/**
 * Outcome of a best-effort, lossless worktree removal (see
 * {@link WorktreeManager.safeRemove}).
 *
 * - `removed`: the worktree is gone from disk and from git's bookkeeping.
 *   `stashed` records whether uncommitted changes were preserved in the
 *   shared stash first.
 * - `absent`: nothing existed at the path; there was nothing to do.
 * - `skipped`: the worktree was deliberately left in place, with a
 *   human-readable reason (it is the repo's main checkout, it is dirty and
 *   stashing failed, or inspecting it failed). Skipped is not an error: the
 *   caller logs it and moves on, and the startup garbage collector will
 *   retry later.
 */
export type SafeWorktreeRemovalOutcome =
  | { readonly status: "removed"; readonly stashed: boolean }
  | { readonly status: "absent" }
  | { readonly status: "skipped"; readonly reason: string };

export interface WorktreeManager {
  ensureForExistingBranch(entry: GithubRepoEntry, branch: string, options?: WorktreeOperationOptions): Promise<string>;
  ensureForNewBranch(entry: GithubRepoEntry, newBranch: string, baseBranch: string, options?: WorktreeOperationOptions): Promise<string>;
  remove(worktreePath: string): Promise<void>;
  safeRemove(worktreePath: string, note: string, options?: WorktreeOperationOptions): Promise<SafeWorktreeRemovalOutcome>;
  /** Whether anything exists at the path. Lets lifecycle bookkeeping skip
   * holds on worktrees that were already reclaimed out-of-band. */
  exists(worktreePath: string): Promise<boolean>;
  /** The worktree's current HEAD state: the checked-out branch name (null
   * when detached or unreadable) and the commit SHA (null when unreadable).
   * Used to find the pull request an agent produced even when it renamed
   * the branch before pushing. Best-effort: failures resolve to nulls. */
  currentHead(worktreePath: string, options?: WorktreeOperationOptions): Promise<WorktreeHeadState>;
}

export interface WorktreeHeadState {
  readonly branch: string | null;
  readonly sha: string | null;
}
