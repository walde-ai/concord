import { describe, it, expect } from "vitest";

import {
  WorktreeLeaseRegistry,
  DEFAULT_FAILED_WORKTREE_HOLD_MS,
  DEFAULT_SUCCEEDED_REMOVAL_GRACE_MS,
  type RemovalScheduler,
} from "../src/infra/adapters/git/worktree-lease-registry";
import type { TerminalRunState } from "../src/domain/ports/out/run-completion-hook";
import { FakeWorktreeManager } from "./fakes";
import type { Logger } from "../src/domain/ports/out/logger";

const HOUR_MS = 60 * 60 * 1000;

function recordingLogger(): { logger: Logger; entries: Array<{ level: string; source: string; message: string; fields: Record<string, unknown> }> } {
  const entries: Array<{ level: string; source: string; message: string; fields: Record<string, unknown> }> = [];
  const record = (level: string) => (source: string, message: string, fields?: Readonly<Record<string, unknown>>) => {
    entries.push({ level, source, message, fields: { ...(fields ?? {}) } });
  };
  return {
    logger: {
      info: record("info"),
      warn: record("warn"),
      error: record("error"),
      debug: record("debug"),
      log: () => {},
    },
    entries,
  };
}

function makeRegistry() {
  const manager = new FakeWorktreeManager();
  const { logger, entries } = recordingLogger();
  let nowMs = Date.parse("2026-08-24T12:00:00Z");
  // Manual grace scheduler: deferred removals only fire when the test says
  // so, making the concord#24 race windows deterministic.
  const timers: Array<{ readonly fire: () => void }> = [];
  const scheduler: RemovalScheduler = (_delayMs, fire) => {
    // One-shot like a real setTimeout: a fired timer never fires again.
    const entry: { fire: () => void } = {
      fire: () => {
        const index = timers.indexOf(entry);
        if (index >= 0) {
          timers.splice(index, 1);
        }
        fire();
      },
    };
    timers.push(entry);
    return () => {
      const index = timers.indexOf(entry);
      if (index >= 0) {
        timers.splice(index, 1);
      }
    };
  };
  const registry = new WorktreeLeaseRegistry(
    manager,
    logger,
    DEFAULT_FAILED_WORKTREE_HOLD_MS,
    () => nowMs,
    DEFAULT_SUCCEEDED_REMOVAL_GRACE_MS,
    scheduler,
  );
  return {
    manager,
    entries,
    registry,
    advanceMs: (delta: number): void => {
      nowMs += delta;
    },
    // Fires every live grace timer and drains the async removals it kicks
    // off (they run detached, so a macrotask boundary is needed).
    fireGrace: async (): Promise<void> => {
      for (const timer of [...timers]) {
        timer.fire();
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
  };
}

function succeeded(runId: string) {
  return { runId, state: "SUCCEEDED" as const };
}

function endedWith(runId: string, state: TerminalRunState) {
  return { runId, state };
}

describe("WorktreeLeaseRegistry", () => {
  it("defers a succeeded run's worktree removal for the grace window, then reclaims it", async () => {
    const { manager, registry, fireGrace } = makeRegistry();
    registry.track("run-1", "/wt/feature-a");
    await registry.runFinished(succeeded("run-1"));
    // concord#24: the successor run in the same chain needs the window to
    // acquire and track the shared path, so nothing is removed yet.
    expect(manager.safeRemovals).toHaveLength(0);
    await fireGrace();
    expect(manager.safeRemovals).toHaveLength(1);
    expect(manager.safeRemovals[0].worktreePath).toBe("/wt/feature-a");
    expect(manager.safeRemovals[0].note).toContain("run-1");
  });

  it("drops the deferred removal when a successor run tracks the path within the grace (concord#24 race)", async () => {
    const { manager, entries, registry, fireGrace } = makeRegistry();
    registry.track("run-1", "/wt/feature-shared");
    await registry.runFinished(succeeded("run-1"));
    // The successor (e.g. pr-rework after pr-verify) re-tracks the same path
    // before the grace fires: the removal must be cancelled outright.
    registry.track("run-2", "/wt/feature-shared");
    expect(entries.some((e) => e.message.includes("deferred worktree removal cancelled"))).toBe(true);
    await fireGrace();
    expect(manager.safeRemovals).toHaveLength(0);
    // The successor's own lifecycle now governs the path: it holds on
    // failure rather than letting the stale removal through.
    await registry.runFinished(endedWith("run-2", "FAILED"));
    await fireGrace();
    expect(manager.safeRemovals).toHaveLength(0);
    expect(entries.some((e) => e.message.includes("holding worktree of failed run"))).toBe(true);
  });

  it("keeps a shared worktree until the last owning run finishes", async () => {
    // Two concurrent consumers react to the same PR branch and share one
    // worktree; the first run ending must not tear it out from under the
    // second.
    const { manager, registry, fireGrace } = makeRegistry();
    registry.track("run-1", "/wt/feature-shared");
    registry.track("run-2", "/wt/feature-shared");
    await registry.runFinished(succeeded("run-1"));
    expect(manager.safeRemovals).toHaveLength(0);
    await registry.runFinished(succeeded("run-2"));
    await fireGrace();
    expect(manager.safeRemovals).toHaveLength(1);
  });

  it("does not double-count a path tracked twice by the same run", async () => {
    const { manager, registry, fireGrace } = makeRegistry();
    registry.track("run-1", "/wt/feature-a");
    registry.track("run-1", "/wt/feature-a");
    await registry.runFinished(succeeded("run-1"));
    await fireGrace();
    expect(manager.safeRemovals).toHaveLength(1);
  });

  it("keeps a handed-off worktree so the receiving run can use it", async () => {
    const { manager, entries, registry, fireGrace } = makeRegistry();
    registry.track("run-1", "/wt/concord/fix-9");
    registry.handoff("/wt/concord/fix-9");
    await registry.runFinished(succeeded("run-1"));
    expect(manager.safeRemovals).toHaveLength(0);
    expect(entries.some((e) => e.message.includes("handed off"))).toBe(true);
  });

  it("keeps a handed-off worktree even when its run ended in a failure state", async () => {
    // The handoff contract precedes the hold policy: pr-publish may still
    // consume the payload, so the mark governs regardless of outcome.
    const { manager, registry, fireGrace } = makeRegistry();
    registry.track("run-1", "/wt/concord/fix-9");
    registry.handoff("/wt/concord/fix-9");
    await registry.runFinished(endedWith("run-1", "FAILED"));
    expect(manager.safeRemovals).toHaveLength(0);
  });

  it.each(["FAILED", "TIMED_OUT", "ABORTED", "SUPERSEDED"] as const)(
    "holds the worktree of a run that ended %s instead of removing it",
    async (state) => {
      // Operator decision (concord#21): failure states hold their worktree
      // for a while so a re-started run can pick the work up where it left
      // off, without ditching it completely.
      const { manager, entries, registry, fireGrace } = makeRegistry();
      registry.track("run-1", "/wt/fix-foo");
      await registry.runFinished(endedWith("run-1", state));
      expect(manager.safeRemovals).toHaveLength(0);
      expect(entries.some((e) => e.message.includes("holding worktree of failed run"))).toBe(true);
    },
  );

  it("keeps a held worktree for the whole 48-hour hold, then reclaims it once expired", async () => {
    const { manager, registry, advanceMs, fireGrace } = makeRegistry();
    registry.track("run-1", "/wt/fix-foo");
    await registry.runFinished(endedWith("run-1", "FAILED"));

    // One hour short of the hold: a concurrent unrelated completion sweeps
    // but must not touch the unexpired hold.
    registry.track("run-9", "/wt/other");
    advanceMs(47 * HOUR_MS);
    await registry.runFinished(succeeded("run-9"));
    await fireGrace();
    expect(manager.safeRemovals.map((r) => r.worktreePath)).toEqual(["/wt/other"]);

    // Past the hold: the sweep reclaims it, attributing the expired hold.
    advanceMs(2 * HOUR_MS);
    registry.track("run-10", "/wt/other");
    await registry.runFinished(succeeded("run-10"));
    await fireGrace();
    expect(manager.safeRemovals).toHaveLength(3);
    const reclaimed = manager.safeRemovals.find((r) => r.worktreePath === "/wt/fix-foo");
    expect(reclaimed?.note).toContain("run-1");
    expect(reclaimed?.note).toContain("expired");
  });

  it("lets a restarted run reuse a held worktree and reclaims it through the new run's own lifecycle", async () => {
    // The point of the hold: a re-started run on the same branch re-tracks
    // the path, works against the surviving checkout, and its OWN terminal
    // state decides the worktree's fate (immediate removal on success).
    const { manager, registry, advanceMs, fireGrace } = makeRegistry();
    registry.track("run-1", "/wt/fix-foo");
    await registry.runFinished(endedWith("run-1", "FAILED"));

    advanceMs(24 * HOUR_MS);
    registry.track("run-2", "/wt/fix-foo");
    // The old hold must not fire long after this run took the path over.
    advanceMs(30 * HOUR_MS);
    registry.track("run-9", "/wt/other");
    await registry.runFinished(succeeded("run-9"));
    await fireGrace();
    expect(manager.safeRemovals.map((r) => r.worktreePath)).toEqual(["/wt/other"]);

    await registry.runFinished(succeeded("run-2"));
    await fireGrace();
    expect(manager.safeRemovals).toHaveLength(2);
    expect(manager.safeRemovals[1].worktreePath).toBe("/wt/fix-foo");
  });

  it("clears a stale handoff mark when a new run re-tracks the unowned path", async () => {
    // Worktree paths are deterministic per branch and PR head branches are
    // reused across runs: a run hands /wt/fix-foo off (pr.missing), pr-publish
    // consumes and removes the worktree, but the mark stays forever. Every
    // later run on fix/foo that finishes WITHOUT a handoff must still have its
    // worktree reclaimed — a mark left on a path with no current owners is
    // stale by definition and must not suppress reclamation.
    const { manager, registry, fireGrace } = makeRegistry();
    registry.track("run-1", "/wt/fix-foo");
    registry.handoff("/wt/fix-foo");
    await registry.runFinished(succeeded("run-1"));
    // pr-publish consumed the handoff out-of-band; a later run re-tracks the
    // same branch path and finishes without any handoff.
    registry.track("run-2", "/wt/fix-foo");
    await registry.runFinished(succeeded("run-2"));
    await fireGrace();
    expect(manager.safeRemovals).toHaveLength(1);
    expect(manager.safeRemovals[0].worktreePath).toBe("/wt/fix-foo");
    expect(manager.safeRemovals[0].note).toContain("run-2");
  });

  it("clears a stale handoff mark even when the later run fails, so the hold applies instead", async () => {
    // The same stale-mark leak, seen through the hold policy: the new run's
    // own failure must produce a hold (and a later expiry removal), not be
    // suppressed by the consumed mark's "handed off" log line.
    const { manager, registry, advanceMs, fireGrace } = makeRegistry();
    registry.track("run-1", "/wt/fix-foo");
    registry.handoff("/wt/fix-foo");
    await registry.runFinished(succeeded("run-1"));
    registry.track("run-2", "/wt/fix-foo");
    await registry.runFinished(endedWith("run-2", "FAILED"));
    advanceMs(49 * HOUR_MS);
    registry.track("run-9", "/wt/other");
    await registry.runFinished(succeeded("run-9"));
    await fireGrace();
    const reclaimed = manager.safeRemovals.find((r) => r.worktreePath === "/wt/fix-foo");
    expect(reclaimed?.note).toContain("run-2");
  });

  it("keeps a handoff mark on a path still owned by a live run", async () => {
    // A handoff is a property of a path: while a live run still owns the path
    // (it may be the emitting run or a concurrent sharer), a new run tracking
    // it must NOT clear the mark — a future pr-publish may still expect the
    // worktree to be there.
    const { manager, registry, fireGrace } = makeRegistry();
    registry.track("run-1", "/wt/fix-shared");
    registry.track("run-2", "/wt/fix-shared");
    registry.handoff("/wt/fix-shared");
    await registry.runFinished(succeeded("run-1"));
    expect(manager.safeRemovals).toHaveLength(0);
    await registry.runFinished(succeeded("run-2"));
    expect(manager.safeRemovals).toHaveLength(0);
  });

  it("is a no-op for an unknown run id", async () => {
    const { registry, fireGrace } = makeRegistry();
    await expect(registry.runFinished(succeeded("never-tracked"))).resolves.toBeUndefined();
  });

  it("is idempotent when runFinished fires twice for the same run", async () => {
    const { manager, registry, fireGrace } = makeRegistry();
    registry.track("run-1", "/wt/feature-a");
    await registry.runFinished(succeeded("run-1"));
    await registry.runFinished(succeeded("run-1"));
    await fireGrace();
    expect(manager.safeRemovals).toHaveLength(1);
  });

  it("logs a warning instead of throwing when removal reports skipped", async () => {
    const { manager, entries, registry, fireGrace } = makeRegistry();
    manager.safeRemoveOutcome = { status: "skipped", reason: "worktree is dirty and stashing failed" };
    registry.track("run-1", "/wt/feature-stuck");
    await expect(registry.runFinished(succeeded("run-1"))).resolves.toBeUndefined();
    await fireGrace();
    const warning = entries.find((e) => e.level === "warn");
    expect(warning?.fields.reason).toContain("stashing failed");
  });

  it("tracks a reclaimed path again when a later run reuses it", async () => {
    // After a worktree is removed, a future run may check the same branch out
    // again at the same path; its lease must lead to a fresh removal.
    const { manager, registry, fireGrace } = makeRegistry();
    registry.track("run-1", "/wt/feature-a");
    await registry.runFinished(succeeded("run-1"));
    await fireGrace();
    registry.track("run-2", "/wt/feature-a");
    await registry.runFinished(succeeded("run-2"));
    await fireGrace();
    expect(manager.safeRemovals).toHaveLength(2);
  });

  it("records no ghost hold when the failed run's worktree was already removed out-of-band", async () => {
    const { manager, entries, registry, fireGrace } = makeRegistry();
    registry.track("run-1", "/wt/fix-ghost");
    manager.absentPaths.add("/wt/fix-ghost");
    await registry.runFinished(endedWith("run-1", "FAILED"));
    expect(entries.some((e) => e.message.includes("already absent while recording restart hold"))).toBe(true);
    // Nothing was held, so no later sweep can "reclaim" it either.
    registry.track("run-9", "/wt/other");
    await registry.runFinished(succeeded("run-9"));
    await fireGrace();
    expect(manager.safeRemovals.find((r) => r.worktreePath === "/wt/fix-ghost")).toBeUndefined();
  });
});
