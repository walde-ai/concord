import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";

import { GitWorktreeManager } from "../src/infra/adapters/git/git-worktree-manager";
import { WorktreeGarbageCollector } from "../src/infra/adapters/git/worktree-garbage-collector";
import { noopLogger } from "../src/domain/ports/out/logger";
import type { GithubRepoEntry } from "../src/infra/adapters/producers/github/github-repos-context";

let tempRoot: string;
let primaryDir: string;
let worktreesDir: string;
let entry: GithubRepoEntry;
let manager: GitWorktreeManager;

const DAY_MS = 24 * 60 * 60 * 1000;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

// The collector compares directory mtimes against now(); tests backdate a
// worktree instead of injecting a fake clock so the mtime path itself is
// exercised.
function backdate(target: string, ageMs: number): void {
  const stamp = new Date(Date.now() - ageMs);
  fs.utimesSync(target, stamp, stamp);
}

describe("WorktreeGarbageCollector", () => {
  beforeEach(async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "concord-wtgc-"));
    const bare = path.join(tempRoot, "bare.git");
    execFileSync("git", ["init", "--bare", "--initial-branch=main", bare]);
    primaryDir = path.join(tempRoot, "primary");
    execFileSync("git", ["init", "--initial-branch=main", primaryDir]);
    git(primaryDir, "config", "user.email", "test@concord.dev");
    git(primaryDir, "config", "user.name", "Test");
    git(primaryDir, "remote", "add", "origin", bare);
    fs.writeFileSync(path.join(primaryDir, "README.md"), "# app\n");
    git(primaryDir, "add", ".");
    git(primaryDir, "commit", "-m", "initial");
    git(primaryDir, "push", "origin", "main");
    worktreesDir = path.join(tempRoot, "worktrees");
    fs.mkdirSync(worktreesDir, { recursive: true });
    entry = {
      name: "app",
      url: "https://github.com/example-corp/app",
      local: primaryDir,
      worktrees: worktreesDir,
    };
    manager = new GitWorktreeManager();
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  async function worktree(branch: string): Promise<string> {
    return await manager.ensureForNewBranch(entry, branch, "main");
  }

  it("removes an old clean worktree under the worktrees root and keeps a fresh one", async () => {
    const stale = await worktree("concord/worker-a/old");
    const fresh = await worktree("concord/worker-a/fresh");
    backdate(stale, 5 * DAY_MS);

    const collector = new WorktreeGarbageCollector(manager, noopLogger, 3 * DAY_MS);
    const summary = await collector.collect([entry]);

    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(summary.removed).toBe(1);
    expect(summary.kept).toBe(1);
  });

  it("stashes uncommitted work before collecting a dirty old worktree", async () => {
    const stale = await worktree("concord/worker-d/dirty");
    fs.writeFileSync(path.join(stale, "WIP.txt"), "uncommitted agent work\n");
    backdate(stale, 5 * DAY_MS);

    const collector = new WorktreeGarbageCollector(manager, noopLogger, 3 * DAY_MS);
    await collector.collect([entry]);

    expect(fs.existsSync(stale)).toBe(false);
    const stashList = git(primaryDir, "stash", "list");
    expect(stashList).toContain("concord-worktree-cleanup: startup garbage collection");
  });

  it("never touches the primary checkout or a worktree outside the worktrees root", async () => {
    const foreign = path.join(tempRoot, "foreign-leak");
    git(primaryDir, "worktree", "add", "--detach", foreign, "main");
    backdate(foreign, 30 * DAY_MS);

    const collector = new WorktreeGarbageCollector(manager, noopLogger, 3 * DAY_MS);
    const summary = await collector.collect([entry]);

    expect(fs.existsSync(primaryDir)).toBe(true);
    expect(fs.existsSync(foreign)).toBe(true);
    expect(summary.removed).toBe(0);
  });

  it("prunes stale bookkeeping for worktrees whose directory is already gone", async () => {
    const gone = await worktree("concord/worker-a/gone");
    fs.rmSync(gone, { recursive: true, force: true });
    // Out-of-band removal leaves git bookkeeping behind.
    expect(git(primaryDir, "worktree", "list", "--porcelain")).toContain("concord/worker-a/gone");

    const collector = new WorktreeGarbageCollector(manager, noopLogger, 3 * DAY_MS);
    await collector.collect([entry]);

    expect(git(primaryDir, "worktree", "list", "--porcelain")).not.toContain("concord/worker-a/gone");
  });

  it("skips repos without local or worktrees configuration", async () => {
    const incomplete: GithubRepoEntry[] = [
      { name: "a", url: "https://github.com/o/a" },
      { name: "b", url: "https://github.com/o/b", local: primaryDir },
    ];
    const collector = new WorktreeGarbageCollector(manager, noopLogger, 3 * DAY_MS);
    const summary = await collector.collect(incomplete);
    expect(summary.repos).toBe(0);
    expect(summary.inspected).toBe(0);
  });
});
