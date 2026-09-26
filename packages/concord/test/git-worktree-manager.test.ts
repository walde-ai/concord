import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";

import { GitWorktreeManager } from "../src/infra/adapters/git/git-worktree-manager";
import type { GithubRepoEntry } from "../src/infra/adapters/producers/github/github-repos-context";

let tempRoot: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function makeTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "concord-wt-"));
}

function initBareRepo(dir: string): void {
  execFileSync("git", ["init", "--bare", "--initial-branch=main", dir]);
}

function initPrimary(bareUrl: string, primaryDir: string): void {
  execFileSync("git", ["init", "--initial-branch=main", primaryDir]);
  git(primaryDir, "config", "user.email", "test@concord.dev");
  git(primaryDir, "config", "user.name", "Test");
  git(primaryDir, "remote", "add", "origin", bareUrl);
  fs.writeFileSync(path.join(primaryDir, "README.md"), "# app\n");
  git(primaryDir, "add", ".");
  git(primaryDir, "commit", "-m", "initial");
  git(primaryDir, "push", "origin", "main");
}

function ensureBranchOnRemote(primaryDir: string, branch: string): void {
  git(primaryDir, "checkout", "-b", branch);
  const safe = branch.replace(/[^a-zA-Z0-9]/g, "-");
  fs.writeFileSync(path.join(primaryDir, `${safe}.txt`), branch);
  git(primaryDir, "add", ".");
  git(primaryDir, "commit", "-m", `branch ${branch}`);
  git(primaryDir, "push", "origin", branch);
  git(primaryDir, "checkout", "main");
}

function entryFor(primaryDir: string, worktreesDir: string): GithubRepoEntry {
  return {
    name: "app",
    url: "https://github.com/example-corp/app",
    local: primaryDir,
    worktrees: worktreesDir,
  };
}

describe("GitWorktreeManager", () => {
  let primaryDir: string;
  let worktreesDir: string;
  let entry: GithubRepoEntry;

  beforeEach(() => {
    tempRoot = makeTempRoot();
    const bare = path.join(tempRoot, "bare.git");
    initBareRepo(bare);
    primaryDir = path.join(tempRoot, "primary");
    initPrimary(bare, primaryDir);
    worktreesDir = path.join(tempRoot, "worktrees");
    fs.mkdirSync(worktreesDir, { recursive: true });
    entry = entryFor(primaryDir, worktreesDir);
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("ensureForExistingBranch creates a worktree tracking origin/<branch>", async () => {
    ensureBranchOnRemote(primaryDir, "feature/existing");
    const manager = new GitWorktreeManager();
    const result = await manager.ensureForExistingBranch(entry, "feature/existing");
    expect(result).toBe(path.join(worktreesDir, "feature/existing"));
    expect(fs.existsSync(result)).toBe(true);
  });

  it("ensureForExistingBranch returns the same path when called twice", async () => {
    ensureBranchOnRemote(primaryDir, "feature/existing");
    const manager = new GitWorktreeManager();
    const first = await manager.ensureForExistingBranch(entry, "feature/existing");
    const second = await manager.ensureForExistingBranch(entry, "feature/existing");
    expect(first).toBe(second);
  });

  it("ensureForExistingBranch reuses an existing worktree when the branch is already checked out elsewhere", async () => {
    // Reproduces the github-failure-fix failure: another consumer (here a leaked
    // pipeline-fix worktree) already has the branch checked out at a different
    // path, so a naive `git worktree add` for the same branch would fail with
    // "fatal: '<branch>' is already used by worktree at '<path>'". The manager
    // must detect this and reuse the existing worktree instead of failing.
    ensureBranchOnRemote(primaryDir, "feature/conflict");
    const otherPath = path.join(tempRoot, "leaked-worktree");
    git(primaryDir, "worktree", "add", "--track", "-B", "feature/conflict", otherPath, "origin/feature/conflict");
    const manager = new GitWorktreeManager();
    const result = await manager.ensureForExistingBranch(entry, "feature/conflict");
    expect(result).toBe(otherPath);
    expect(fs.existsSync(otherPath)).toBe(true);
    // The canonical path was NOT created — the existing worktree is reused.
    expect(fs.existsSync(path.join(worktreesDir, "feature/conflict"))).toBe(false);
  });

  it("ensureForExistingBranch prunes a stale worktree entry and recreates the worktree when the branch dir is gone", async () => {
    // A worktree's directory was removed out-of-band (not via `git worktree
    // remove`), leaving git bookkeeping that still claims the branch is checked
    // out there. Reusing the stale path would hand the agent a missing dir, and
    // a naive `worktree add` would still fail with "already used by worktree".
    // The manager prunes the stale bookkeeping and recreates the worktree.
    ensureBranchOnRemote(primaryDir, "feature/stale");
    const otherPath = path.join(tempRoot, "stale-worktree");
    git(primaryDir, "worktree", "add", "--track", "-B", "feature/stale", otherPath, "origin/feature/stale");
    fs.rmSync(otherPath, { recursive: true, force: true });
    const manager = new GitWorktreeManager();
    const result = await manager.ensureForExistingBranch(entry, "feature/stale");
    expect(result).toBe(path.join(worktreesDir, "feature/stale"));
    expect(fs.existsSync(result)).toBe(true);
  });

  it("ensureForExistingBranch retries a transient git fetch failure before setting up the worktree", async () => {
    // Reproduces the pipeline-fix failures: git fetch fails with a one-off
    // network blip that clears on retry. A fake runner simulates the blip on the
    // first fetch and succeeds on the second; instant sleep keeps the test fast.
    ensureBranchOnRemote(primaryDir, "feature/retry");
    let fetchAttempts = 0;
    const runner = {
      run: vi.fn(async (_cwd: string, args: readonly string[]) => {
        if (args[0] === "fetch") {
          fetchAttempts = fetchAttempts + 1;
          if (fetchAttempts === 1) {
            throw new Error(
              "git fetch origin feature/retry exited with 128: fatal: unable to access " +
                "'https://github.com/example-corp/app.git/': Failed to connect to " +
                "github.com port 443 after 1043 ms: Could not connect to server",
            );
          }
        }
      }),
      capture: vi.fn(async () => ""),
    };
    const manager = new GitWorktreeManager(runner, {}, { sleep: () => Promise.resolve() });
    await manager.ensureForExistingBranch(entry, "feature/retry");
    expect(fetchAttempts).toBe(2);
  });

  it("ensureForNewBranch creates a new branch off the base and a worktree for it", async () => {
    const manager = new GitWorktreeManager();
    const result = await manager.ensureForNewBranch(entry, "concord/fix-1", "main");
    expect(result).toBe(path.join(worktreesDir, "concord/fix-1"));
    expect(fs.existsSync(result)).toBe(true);
    // branch exists on the primary
    const branches = git(primaryDir, "branch", "--list", "concord/fix-1");
    expect(branches).toContain("concord/fix-1");
  });

  it("ensureForNewBranch returns the same path when called twice (restart after a failed run)", async () => {
    const manager = new GitWorktreeManager();
    const first = await manager.ensureForNewBranch(entry, "concord/fix-restart", "main");
    // Simulate a restart: the previous run created the branch + worktree but never pushed it.
    const second = await manager.ensureForNewBranch(entry, "concord/fix-restart", "main");
    expect(second).toBe(first);
    expect(fs.existsSync(second)).toBe(true);
  });

  it("ensureForNewBranch recovers when a stale local branch exists but the worktree is gone", async () => {
    const branch = "concord/fix-stale";
    const manager = new GitWorktreeManager();
    // First run: creates a local branch off main but never pushes it, and its worktree is later
    // torn down (e.g. a previous run that failed before producing a PR).
    await manager.ensureForNewBranch(entry, branch, "main");
    git(primaryDir, "worktree", "remove", "--force", path.join(worktreesDir, branch));
    // Restart: must not crash with "a branch named ... already exists".
    const result = await manager.ensureForNewBranch(entry, branch, "main");
    expect(result).toBe(path.join(worktreesDir, branch));
    expect(fs.existsSync(result)).toBe(true);
    // The recovered branch is reset to the base commit, not the stale tip.
    const baseSha = git(primaryDir, "rev-parse", "origin/main");
    const branchSha = git(primaryDir, "rev-parse", branch);
    expect(branchSha).toBe(baseSha);
  });

  it("ensureForNewBranch continues from pushed remote work when the branch exists on origin", async () => {
    const branch = "concord/fix-pushed";
    const manager = new GitWorktreeManager();
    // A prior run pushed the fix branch with a commit on top of main.
    const first = await manager.ensureForNewBranch(entry, branch, "main");
    fs.writeFileSync(path.join(first, "change.txt"), "prior work\n");
    git(first, "config", "user.email", "test@concord.dev");
    git(first, "config", "user.name", "Test");
    git(first, "add", ".");
    git(first, "commit", "-m", "prior work");
    git(primaryDir, "push", "origin", branch);
    const priorSha = git(primaryDir, "rev-parse", `origin/${branch}`);
    // Restart: the worktree is rebuilt from the pushed branch, preserving prior work.
    git(primaryDir, "worktree", "remove", "--force", first);
    const second = await manager.ensureForNewBranch(entry, branch, "main");
    const checkedOutSha = git(second, "rev-parse", "HEAD");
    expect(checkedOutSha).toBe(priorSha);
  });

  it("remove deletes the worktree", async () => {
    ensureBranchOnRemote(primaryDir, "feature/to-remove");
    const manager = new GitWorktreeManager();
    const target = await manager.ensureForExistingBranch(entry, "feature/to-remove");
    expect(fs.existsSync(target)).toBe(true);
    await manager.remove(target);
    expect(fs.existsSync(target)).toBe(false);
  });

  it("safeRemove removes a clean worktree without creating a stash", async () => {
    ensureBranchOnRemote(primaryDir, "feature/safe-clean");
    const manager = new GitWorktreeManager();
    const target = await manager.ensureForExistingBranch(entry, "feature/safe-clean");
    const outcome = await manager.safeRemove(target, "run test-1 finished");
    expect(outcome).toEqual({ status: "removed", stashed: false });
    expect(fs.existsSync(target)).toBe(false);
    // git's bookkeeping no longer lists it
    const listed = git(primaryDir, "worktree", "list", "--porcelain");
    expect(listed).not.toContain(target);
    expect(git(primaryDir, "stash", "list")).toBe("");
  });

  it("safeRemove stashes uncommitted work before removing a dirty worktree", async () => {
    ensureBranchOnRemote(primaryDir, "feature/safe-dirty");
    const manager = new GitWorktreeManager();
    const target = await manager.ensureForExistingBranch(entry, "feature/safe-dirty");
    // An agent run that was interrupted mid-work: a modified tracked file and
    // an untracked one, neither committed nor pushed.
    fs.writeFileSync(path.join(target, "README.md"), "# changed\n");
    fs.writeFileSync(path.join(target, "untracked.txt"), "scratch\n");
    const outcome = await manager.safeRemove(target, "run test-2 finished");
    expect(outcome).toEqual({ status: "removed", stashed: true });
    expect(fs.existsSync(target)).toBe(false);
    // The uncommitted work survives on the shared stash with the descriptive
    // note, recoverable by a human afterwards.
    const stashList = git(primaryDir, "stash", "list");
    expect(stashList).toContain("concord-worktree-cleanup: run test-2 finished");
  });

  it("safeRemove reports absent when nothing exists at the path", async () => {
    const manager = new GitWorktreeManager();
    const outcome = await manager.safeRemove(path.join(worktreesDir, "never-created"), "run test-3 finished");
    expect(outcome).toEqual({ status: "absent" });
  });

  it("safeRemove refuses to remove the repository's main checkout", async () => {
    const manager = new GitWorktreeManager();
    const outcome = await manager.safeRemove(primaryDir, "run test-4 finished");
    expect(outcome).toEqual({
      status: "skipped",
      reason: "refusing to remove the repository's main checkout",
    });
    expect(fs.existsSync(primaryDir)).toBe(true);
  });

  it("throws when the entry has no local path", async () => {
    const noLocal: GithubRepoEntry = { name: "app", url: "https://github.com/example-corp/app" };
    const manager = new GitWorktreeManager();
    await expect(manager.ensureForExistingBranch(noLocal, "main")).rejects.toThrow(/no local working tree/);
    await expect(manager.ensureForNewBranch(noLocal, "x", "main")).rejects.toThrow(/no local working tree/);
  });

  it("throws when the entry has no worktrees folder", async () => {
    const noWorktrees: GithubRepoEntry = {
      name: "app",
      url: "https://github.com/example-corp/app",
      local: primaryDir,
    };
    const manager = new GitWorktreeManager();
    await expect(manager.ensureForExistingBranch(noWorktrees, "feature/x")).rejects.toThrow(/no worktrees folder/);
  });

  it("throws MissingGitWorkingTreeError when the local path does not exist on disk", async () => {
    const missingLocal: GithubRepoEntry = {
      name: "app",
      url: "https://github.com/example-corp/app",
      local: path.join(tempRoot, "does-not-exist"),
      worktrees: worktreesDir,
    };
    const manager = new GitWorktreeManager();
    await expect(manager.ensureForExistingBranch(missingLocal, "feature/x")).rejects.toThrow(
      /Primary git working tree for repo "app" does not exist/,
    );
    await expect(manager.ensureForNewBranch(missingLocal, "feature/y", "main")).rejects.toThrow(
      /Primary git working tree for repo "app" does not exist/,
    );
  });
});

describe("ChildProcessGitRunner cwd validation", () => {  let scratch: string;

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "concord-runner-"));
  });

  afterEach(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it("rejects with a clear error when cwd does not exist instead of misleading spawn ENOENT", async () => {
    const { ChildProcessGitRunner } = await import("../src/infra/adapters/git/git-worktree-manager");
    const runner = new ChildProcessGitRunner();
    await expect(runner.run(path.join(scratch, "does-not-exist"), ["status"])).rejects.toThrow(
      /working directory .* does not exist/,
    );
  });

  it("rejects when cwd exists but is not a directory", async () => {
    const { ChildProcessGitRunner } = await import("../src/infra/adapters/git/git-worktree-manager");
    const file = path.join(scratch, "not-a-dir");
    fs.writeFileSync(file, "data");
    const runner = new ChildProcessGitRunner();
    await expect(runner.run(file, ["status"])).rejects.toThrow(/is not a directory/);
  });
});

describe("ChildProcessGitRunner timeout and abort", () => {
  let scratch: string;

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "concord-runner-timeout-"));
  });

  afterEach(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  // A fake "git" that ignores its args and sleeps, so the runner's timeout
  // and abort paths can be exercised deterministically without a flaky network.
  function writeSleepingGit(directory: string): string {
    const script = path.join(directory, "fake-git.sh");
    fs.writeFileSync(
      script,
      "#!/usr/bin/env sh\nsleep 60\n",
    );
    fs.chmodSync(script, 0o755);
    return script;
  }

  function resolverReturning(resolved: string) {
    return { resolve: async () => resolved };
  }

  it("rejects with a timeout error when the command exceeds its timeout", async () => {
    const { ChildProcessGitRunner, GitCommandTimeoutError } = await import(
      "../src/infra/adapters/git/git-worktree-manager"
    );
    const fakeGit = writeSleepingGit(scratch);
    const runner = new ChildProcessGitRunner(resolverReturning(fakeGit));
    await expect(runner.run(scratch, ["fetch", "origin", "main"], { timeoutMs: 200 })).rejects.toBeInstanceOf(
      GitCommandTimeoutError,
    );
  });

  it("rejects with an aborted error when the caller signal fires", async () => {
    const { ChildProcessGitRunner, GitCommandAbortedError } = await import(
      "../src/infra/adapters/git/git-worktree-manager"
    );
    const fakeGit = writeSleepingGit(scratch);
    const runner = new ChildProcessGitRunner(resolverReturning(fakeGit));
    const controller = new AbortController();
    const promise = runner.run(scratch, ["fetch", "origin", "main"], { timeoutMs: 60_000, signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toBeInstanceOf(GitCommandAbortedError);
  });

  it("capture returns the command's stdout", async () => {
    const { ChildProcessGitRunner } = await import("../src/infra/adapters/git/git-worktree-manager");
    git(scratch, "init", "--initial-branch=main");
    git(scratch, "config", "user.email", "test@concord.dev");
    git(scratch, "config", "user.name", "Test");
    fs.writeFileSync(path.join(scratch, "file.txt"), "x");
    git(scratch, "add", ".");
    git(scratch, "commit", "-m", "one");
    const runner = new ChildProcessGitRunner();
    const out = await runner.capture(scratch, ["log", "--format=%s", "-n", "1"]);
    expect(out.trim()).toBe("one");
  });
});
