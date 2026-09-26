import { spawn, type ChildProcess } from "child_process";
import path from "path";

import type { WorktreeManager, WorktreeOperationOptions, SafeWorktreeRemovalOutcome, WorktreeHeadState } from "../../../domain/ports/out/worktree-manager";
import type { GithubRepoEntry } from "../producers/github/github-repos-context";
import { MissingGitWorkingTreeError, UnexpectedStateError } from "../../../domain/exceptions/errors";
import {
  PathBinaryResolver,
  robustSpawnEnv,
  type BinaryResolver,
} from "../system/binary-resolver";
import { withGitRetry, DEFAULT_GIT_RETRY_OPTIONS, type GitRetryDeps } from "./git-retry";

// git's own network timeouts are effectively unbounded: a `fetch` or `push`
// over a connection that has been accepted but then stalls can hang for many
// minutes (until TCP keepalive) with no output, silently consuming a run. Bound
// every git command so a stall is surfaced as a failure (which the caller can
// retry or fail-fast on) instead of hanging the run until its own timeout.
const DEFAULT_GIT_COMMAND_TIMEOUT_MS = 60_000;

export interface GitCommandOutput {
  readonly stdout: string;
  readonly stderr: string;
}

export interface GitCommandRunner {
  run(cwd: string, args: readonly string[], options?: WorktreeOperationOptions): Promise<void>;
  /** Runs git and returns stdout (rejects on non-zero exit, timeout, or abort). */
  capture(cwd: string, args: readonly string[], options?: WorktreeOperationOptions): Promise<string>;
}

export class ChildProcessGitRunner implements GitCommandRunner {
  public constructor(private readonly resolver: BinaryResolver = new PathBinaryResolver()) {}

  public async run(cwd: string, args: readonly string[], options?: WorktreeOperationOptions): Promise<void> {
    await this.exec(cwd, args, options);
  }

  public async capture(cwd: string, args: readonly string[], options?: WorktreeOperationOptions): Promise<string> {
    return (await this.exec(cwd, args, options)).stdout;
  }

  private async exec(
    cwd: string,
    args: readonly string[],
    options?: WorktreeOperationOptions,
  ): Promise<GitCommandOutput> {
    await ensureCwdExists(cwd);
    const git = await this.resolver.resolve("git");
    const timeoutMs = options?.timeoutMs ?? DEFAULT_GIT_COMMAND_TIMEOUT_MS;
    return new Promise<GitCommandOutput>((resolve, reject) => {
      const child = spawn(git, args as string[], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: robustSpawnEnv(),
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      const finish = (action: () => void): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearAll();
        action();
      };

      const timer = setTimeout(() => {
        killChild(child);
        reject(new GitCommandTimeoutError(args, timeoutMs, stderr));
      }, timeoutMs);

      const onAbort = (): void => {
        killChild(child);
        reject(new GitCommandAbortedError(args, stderr));
      };

      const signal = options?.signal;
      const clearSignal = signal === undefined ? noop : attachAbort(signal, onAbort);

      const clearAll = (): void => {
        clearTimeout(timer);
        clearSignal();
      };

      child.on("error", (err) => {
        finish(() => reject(err));
      });
      child.on("close", (code) => {
        finish(() => {
          if (code === 0) {
            resolve({ stdout, stderr });
          } else {
            reject(new Error(`git ${args.join(" ")} exited with ${code}: ${stderr.trim()}`));
          }
        });
      });
    });
  }
}

function noop(): void {
  // no-op cleanup placeholder
}

function attachAbort(signal: AbortSignal, onAbort: () => void): () => void {
  if (signal.aborted) {
    onAbort();
    return noop;
  }
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

function killChild(child: ChildProcess): void {
  try {
    // SIGTERM lets git release its locks and tear down its network sockets
    // cleanly; a hard SIGKILL risks leaving .git/index.lock and stale refs.
    child.kill("SIGTERM");
  } catch {
    // best-effort: the child may have already exited
  }
}

export class GitCommandTimeoutError extends UnexpectedStateError {
  public constructor(args: readonly string[], timeoutMs: number, stderr: string) {
    const trimmed = stderr.trim();
    super(
      `git ${args.join(" ")} exceeded its ${timeoutMs}ms timeout${
        trimmed.length > 0 ? `: ${trimmed}` : ""
      }`,
    );
  }
}

export class GitCommandAbortedError extends UnexpectedStateError {
  public constructor(args: readonly string[], stderr: string) {
    const trimmed = stderr.trim();
    super(
      `git ${args.join(" ")} was aborted by the caller${
        trimmed.length > 0 ? `: ${trimmed}` : ""
      }`,
    );
  }
}

export class GitWorktreeManager implements WorktreeManager {
  public constructor(
    private readonly runner: GitCommandRunner = new ChildProcessGitRunner(),
    private readonly defaultOptions: WorktreeOperationOptions = {},
    private readonly retryDeps: GitRetryDeps = {},
  ) {}

  public async ensureForExistingBranch(
    entry: GithubRepoEntry,
    branch: string,
    options?: WorktreeOperationOptions,
  ): Promise<string> {
    const local = await this.requireLocal(entry);
    const worktreePath = worktreePathFor(entry, branch);
    const opts = mergeOptions(this.defaultOptions, options);
    await this.fetch(local, branch, opts);
    if (await this.pathExists(worktreePath)) {
      return worktreePath;
    }
    // The branch may already be checked out in another worktree. git forbids
    // the same branch in two worktrees, so a naive `worktree add` fails with
    // "fatal: '<branch>' is already used by worktree at '<path>'". That happens
    // in practice because different consumers react to events on the same PR
    // branch (e.g. a fix run whose agent committed on the base branch,
    // leaving a leaked worktree), and a second consumer then cannot set up its
    // own worktree for that branch. The idempotent recovery is to reuse the
    // worktree that already has the branch checked out. When the recorded entry
    // is stale (its directory was removed out-of-band, leaving only git
    // bookkeeping), prune it so the add below succeeds.
    const existing = await this.findWorktreeForBranch(local, branch, opts);
    if (existing !== null) {
      if (await this.pathExists(existing)) {
        return existing;
      }
      await this.runner.run(local, ["worktree", "prune"], opts);
    }
    await this.runner.run(local, ["worktree", "add", "--track", "-B", branch, worktreePath, `origin/${branch}`], opts);
    return worktreePath;
  }

  public async ensureForNewBranch(
    entry: GithubRepoEntry,
    newBranch: string,
    baseBranch: string,
    options?: WorktreeOperationOptions,
  ): Promise<string> {
    const local = await this.requireLocal(entry);
    const worktreePath = worktreePathFor(entry, newBranch);
    const opts = mergeOptions(this.defaultOptions, options);
    if (await this.pathExists(worktreePath)) {
      return worktreePath;
    }
    // When the branch was already pushed, continue from that remote work; otherwise start a
    // fresh branch off the base.
    const branchOnRemote = await this.remoteBranchExists(local, newBranch, opts);
    const startBranch = branchOnRemote ? newBranch : baseBranch;
    await this.fetch(local, startBranch, opts);
    // `-B` creates the branch when absent or force-resets it to the start point when it already
    // exists. This makes the operation idempotent across restarts: a stale local branch left
    // behind by a previous failed run (which never pushed it) is reset to the intended start
    // point instead of failing with "a branch named ... already exists".
    await this.runner.run(local, ["worktree", "add", "-B", newBranch, worktreePath, `origin/${startBranch}`], opts);
    return worktreePath;
  }

  public async remove(worktreePath: string): Promise<void> {
    // Removing a worktree by path alone (without the primary repo context) is best
    // done by tearing down the directory directly. The git admin metadata becomes
    // stale, but `ensureForExistingBranch` checks the path before reusing, and a
    // periodic `git worktree prune` on the primary cleans up the bookkeeping.
    try {
      await this.runner.run(worktreePath, ["worktree", "remove", "--force", worktreePath]);
    } catch {
      // fall through to filesystem removal
    }
    await fsRemove(worktreePath);
  }

  public async exists(worktreePath: string): Promise<boolean> {
    return this.pathExists(worktreePath);
  }

  public async currentHead(worktreePath: string, options?: WorktreeOperationOptions): Promise<WorktreeHeadState> {
    if (!(await this.pathExists(worktreePath))) {
      return { branch: null, sha: null };
    }
    const opts = mergeOptions(this.defaultOptions, options);
    const read = async (args: readonly string[]): Promise<string | null> => {
      try {
        const out = await this.runner.capture(worktreePath, args, opts);
        const trimmed = out.trim();
        return trimmed.length > 0 ? trimmed : null;
      } catch {
        return null;
      }
    };
    let branch = await read(["rev-parse", "--abbrev-ref", "HEAD"]);
    if (branch === "HEAD") {
      // Detached HEAD: --abbrev-ref reports the literal "HEAD".
      branch = null;
    }
    const sha = await read(["rev-parse", "HEAD"]);
    return { branch, sha };
  }

  // Prefix shared by every stash entry safeRemove creates, so a human can list
  // everything Concord's automated cleanup ever parked with
  // `git stash list | grep concord-worktree-cleanup` and recover it.
  private static readonly STASH_PREFIX = "concord-worktree-cleanup";

  /**
   * Best-effort, lossless removal of a run's worktree — the reclamation path
   * behind run-lifecycle cleanup and the startup garbage collector.
   *
   * Semantics (in order):
   * 1. If nothing exists at the path, report `absent`.
   * 2. Never touch the repository's main checkout (resolved via
   *    `git rev-parse --git-common-dir`): report `skipped` instead.
   * 3. If the worktree is dirty (modified or untracked files — typical for a
   *    run that was aborted mid-work), `git stash push -u` with a descriptive
   *    message on the repo's SHARED stash first, so the work stays recoverable
   *    after the checkout is gone. If stashing fails, SKIP the removal rather
   *    than destroy uncommitted work.
   * 4. `git worktree remove` (falling back to `--force`, then to a direct
   *    filesystem teardown, matching {@link remove}).
   *
   * The method never throws: every failure mode is reported as `skipped` with
   * a reason, because this runs on run-completion paths where a cleanup
   * failure must never fail the run's own outcome.
   */
  public async safeRemove(
    worktreePath: string,
    note: string,
    options?: WorktreeOperationOptions,
  ): Promise<SafeWorktreeRemovalOutcome> {
    const opts = mergeOptions(this.defaultOptions, options);
    try {
      if (!(await this.pathExists(worktreePath))) {
        return { status: "absent" };
      }
      const primary = await this.resolvePrimaryRoot(worktreePath, opts);
      if (primary !== null && path.resolve(primary) === path.resolve(worktreePath)) {
        return { status: "skipped", reason: "refusing to remove the repository's main checkout" };
      }
      let porcelain: string;
      try {
        porcelain = await this.runner.capture(worktreePath, ["status", "--porcelain"], opts);
      } catch (cause) {
        return { status: "skipped", reason: `could not inspect worktree status: ${describeCause(cause)}` };
      }
      let stashed = false;
      if (porcelain.trim().length > 0) {
        try {
          await this.runner.run(
            worktreePath,
            ["stash", "push", "-u", "-m", `${GitWorktreeManager.STASH_PREFIX}: ${note}`],
            opts,
          );
        } catch (cause) {
          return {
            status: "skipped",
            reason: `worktree is dirty and stashing failed; kept to avoid losing uncommitted work: ${describeCause(cause)}`,
          };
        }
        stashed = true;
      }
      // Run the removal from the primary when we know it: git accepts
      // `worktree remove <path>` from any worktree of the repo, but driving
      // it from the primary also works when the target's own metadata is
      // half-broken.
      const cwd = primary ?? worktreePath;
      try {
        await this.runner.run(cwd, ["worktree", "remove", worktreePath], opts);
      } catch {
        try {
          await this.runner.run(cwd, ["worktree", "remove", "--force", worktreePath], opts);
        } catch {
          // Last resort: direct filesystem teardown. The admin metadata goes
          // stale, but ensureForExistingBranch prunes it before recreating.
          await fsRemove(worktreePath);
        }
      }
      return { status: "removed", stashed };
    } catch (cause) {
      return { status: "skipped", reason: describeCause(cause) };
    }
  }

  /** Drops git's administrative bookkeeping for worktrees whose directories
   * no longer exist (removed out-of-band). Safe to run any time; used by the
   * startup garbage collector. */
  public async pruneWorktrees(entry: GithubRepoEntry, options?: WorktreeOperationOptions): Promise<void> {
    const local = await this.requireLocal(entry);
    await this.runner.run(local, ["worktree", "prune"], mergeOptions(this.defaultOptions, options));
  }

  /** Lists every registered worktree path of the entry's repository (the
   * primary checkout first, then linked worktrees), for the garbage
   * collector to inspect. */
  public async listWorktreePaths(entry: GithubRepoEntry, options?: WorktreeOperationOptions): Promise<readonly string[]> {
    const local = await this.requireLocal(entry);
    const porcelain = await this.runner.capture(
      local,
      ["worktree", "list", "--porcelain"],
      mergeOptions(this.defaultOptions, options),
    );
    return parseWorktreePaths(porcelain);
  }

  /**
   * Resolves the repository's primary working-tree root as seen from
   * {@link cwd} (a linked worktree): the parent of the shared `.git` dir that
   * `--git-common-dir` reports. Returns null when the path is not (or is no
   * longer) a usable git working tree.
   */
  private async resolvePrimaryRoot(cwd: string, options: WorktreeOperationOptions): Promise<string | null> {
    try {
      const commonDir = (await this.runner.capture(cwd, ["rev-parse", "--git-common-dir"], options)).trim();
      if (commonDir.length === 0) {
        return null;
      }
      const absolute = path.isAbsolute(commonDir) ? commonDir : path.resolve(cwd, commonDir);
      return path.dirname(absolute);
    } catch {
      return null;
    }
  }

  private async fetch(cwd: string, branch: string, options: WorktreeOperationOptions): Promise<void> {
    // `git fetch` is the operation that touches the network, so a transient
    // connectivity blip (the host's connection to github.com is intermittently
    // unreliable) surfaces here. Retry it the same way the GitHub API client
    // retries, instead of failing the run on a single one-off failure.
    await withGitRetry(
      () => this.runner.run(cwd, ["fetch", "origin", branch], options),
      DEFAULT_GIT_RETRY_OPTIONS,
      options.signal,
      this.retryDeps,
    );
  }

  private async remoteBranchExists(cwd: string, branch: string, options: WorktreeOperationOptions): Promise<boolean> {
    try {
      await withGitRetry(
        () => this.runner.run(cwd, ["ls-remote", "--exit-code", "origin", branch], options),
        DEFAULT_GIT_RETRY_OPTIONS,
        options.signal,
        this.retryDeps,
      );
      return true;
    } catch {
      // A genuine "ref not found" exits non-zero with no transient signature, so
      // it is thrown by withGitRetry immediately and lands here as false. A
      // persistent network failure is also caught here as false — the caller
      // falls back to the base branch, whose own fetch then surfaces the real
      // network error (with retry) instead of misreading it as "absent".
      return false;
    }
  }

  /**
   * Returns the on-disk path of the worktree that already has {@link branch}
   * checked out, or null when no such worktree exists. Used to recover from a
   * "branch already used by worktree" conflict by reusing the existing
   * worktree instead of failing.
   */
  private async findWorktreeForBranch(
    cwd: string,
    branch: string,
    options: WorktreeOperationOptions,
  ): Promise<string | null> {
    const porcelain = await this.runner.capture(cwd, ["worktree", "list", "--porcelain"], options);
    return parseWorktreePathForBranch(porcelain, branch);
  }

  private async requireLocal(entry: GithubRepoEntry): Promise<string> {
    if (entry.local === undefined || entry.local.length === 0) {
      throw new UnexpectedStateError(`Repository entry "${entry.name}" has no local working tree path`);
    }
    if (!(await this.isDirectory(entry.local))) {
      throw new MissingGitWorkingTreeError(entry.name, entry.local);
    }
    return entry.local;
  }

  private async pathExists(target: string): Promise<boolean> {
    const fs = await import("fs");
    try {
      await fs.promises.access(target);
      return true;
    } catch {
      return false;
    }
  }

  private async isDirectory(target: string): Promise<boolean> {
    const fs = await import("fs");
    try {
      return (await fs.promises.stat(target)).isDirectory();
    } catch {
      return false;
    }
  }
}

function worktreePathFor(entry: GithubRepoEntry, branch: string): string {
  if (entry.worktrees === undefined || entry.worktrees.length === 0) {
    throw new UnexpectedStateError(`Repository entry "${entry.name}" has no worktrees folder`);
  }
  return path.join(entry.worktrees, branch);
}

/**
 * Parses `git worktree list --porcelain` output and returns the path of the
 * worktree that has {@link branch} checked out, or null when none matches.
 *
 * The porcelain format is a sequence of blank-line-separated records, each
 * starting with `worktree <path>` followed by `HEAD <sha>` and either
 * `branch refs/heads/<name>` (attached) or `detached`. The matching record's
 * `worktree` line carries the path we want.
 */
function parseWorktreePathForBranch(porcelain: string, branch: string): string | null {
  const target = `branch refs/heads/${branch}`;
  let currentPath: string | null = null;
  for (const rawLine of porcelain.split("\n")) {
    const line = rawLine.trim();
    if (line === "") {
      currentPath = null;
      continue;
    }
    if (line.startsWith("worktree ")) {
      currentPath = line.slice("worktree ".length).trim();
    } else if (line === target) {
      return currentPath;
    }
  }
  return null;
}

/**
 * Parses `git worktree list --porcelain` output and returns the paths of all
 * registered worktrees (primary first, then linked worktrees). Each record
 * starts with a `worktree <path>` line; the primary checkout is simply the
 * first record.
 */
function parseWorktreePaths(porcelain: string): string[] {
  const paths: string[] = [];
  for (const rawLine of porcelain.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("worktree ")) {
      paths.push(line.slice("worktree ".length).trim());
    }
  }
  return paths;
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

async function fsRemove(target: string): Promise<void> {
  const fs = await import("fs");
  try {
    await fs.promises.rm(target, { recursive: true, force: true });
  } catch {
    // ignore — best effort cleanup after worktree removal
  }
}

/**
 * Validates that the spawn `cwd` exists and is a directory. Without this check,
 * `child_process.spawn` fails with a misleading `spawn <binary> ENOENT` error
 * that names the executable instead of the missing working directory.
 */
async function ensureCwdExists(cwd: string): Promise<void> {
  const fs = await import("fs");
  let stats: import("fs").Stats;
  try {
    stats = await fs.promises.stat(cwd);
  } catch {
    throw new Error(`Cannot run git: working directory "${cwd}" does not exist`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`Cannot run git: working directory "${cwd}" is not a directory`);
  }
}

function mergeOptions(
  base: WorktreeOperationOptions,
  overrides: WorktreeOperationOptions | undefined,
): WorktreeOperationOptions {
  if (overrides === undefined) {
    return base;
  }
  // The per-call overrides win when present; otherwise the manager's defaults
  // (e.g. an operator-configured command timeout) are inherited.
  return {
    signal: overrides.signal ?? base.signal,
    timeoutMs: overrides.timeoutMs ?? base.timeoutMs,
  };
}
