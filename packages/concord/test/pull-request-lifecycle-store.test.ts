import { describe, it, expect } from "vitest";

import { InMemoryPullRequestLifecycleStore } from "../src/infra/adapters/producers/github/in-memory-pull-request-lifecycle-store";
import type { PrLifecycleState } from "../src/infra/adapters/producers/github/pull-request-lifecycle-store";

function freshState(headSha: string): PrLifecycleState {
  return {
    headSha,
    openedEmitted: false,
    mergeConflictsEmittedForSha: false,
    testsTerminalEmittedForSha: false,
    consecutiveEmptyScansForSha: 0,
    mergedEmitted: false,
    terminal: false,
  };
}

describe("InMemoryPullRequestLifecycleStore", () => {
  it("returns null for a never-seen key", async () => {
    const store = new InMemoryPullRequestLifecycleStore();
    expect(await store.get("example-corp/app#1")).toBeNull();
  });

  it("round-trips a saved record", async () => {
    const store = new InMemoryPullRequestLifecycleStore();
    const key = "example-corp/app#42";
    const state = freshState("sha-1");

    await store.save(key, state);
    const got = await store.get(key);

    expect(got).toEqual(state);
  });

  it("upserts on save so a second write replaces the first", async () => {
    const store = new InMemoryPullRequestLifecycleStore();
    const key = "example-corp/app#42";

    await store.save(key, freshState("sha-1"));
    await store.save(key, { ...freshState("sha-2"), openedEmitted: true });

    const got = await store.get(key);
    expect(got?.headSha).toBe("sha-2");
    expect(got?.openedEmitted).toBe(true);
  });

  it("lists every stored entry", async () => {
    const store = new InMemoryPullRequestLifecycleStore();
    await store.save("example-corp/app#1", freshState("sha-1"));
    await store.save("example-corp/app#2", freshState("sha-2"));

    const entries = await store.list();
    const keys = entries.map((entry) => entry.key).sort();
    expect(keys).toEqual(["example-corp/app#1", "example-corp/app#2"]);
    expect(entries[0].state).toBeDefined();
  });

  it("supports the SHA-reset semantics the producer relies on", async () => {
    const store = new InMemoryPullRequestLifecycleStore();
    const key = "example-corp/app#9";

    const opened = { ...freshState("sha-a"), openedEmitted: true, testsTerminalEmittedForSha: true };
    await store.save(key, opened);

    const newSha = { ...opened, headSha: "sha-b", mergeConflictsEmittedForSha: false, testsTerminalEmittedForSha: false };
    await store.save(key, newSha);

    const got = await store.get(key);
    expect(got?.headSha).toBe("sha-b");
    expect(got?.openedEmitted).toBe(true);
    expect(got?.mergeConflictsEmittedForSha).toBe(false);
    expect(got?.testsTerminalEmittedForSha).toBe(false);
  });
});
