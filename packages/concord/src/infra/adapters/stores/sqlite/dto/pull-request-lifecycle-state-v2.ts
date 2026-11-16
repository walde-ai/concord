import type { PrLifecycleState, EmittedTestsOutcome } from "../../../producers/github/pull-request-lifecycle-store";

// Persists the GitHub PR producer's per-PR lifecycle state so a server restart
// does not lose it. Without durability the producer re-discovers every open PR
// on startup, finds no recorded state, and re-emits pr.opened for each —
// retriggering downstream consumers and producing duplicate noise. The whole
// state object is serialised as a single JSON blob: it is small, read/written
// atomically as a unit, and adding a field later only needs a DTO bump.
//
// v2 replaces the boolean `testsTerminalEmittedForSha` with the richer
// `testsOutcomeEmittedForSha: "failed" | "succeeded" | null` so the producer
// can distinguish "failed verdict emitted, keep watching for a green re-run"
// from "succeeded verdict emitted, SHA fully terminal".
export class PullRequestLifecycleStateV2 {
  public static readonly version = "v2";

  public constructor(
    public readonly key: string,
    public readonly state: PrLifecycleState,
  ) {}

  public toJson(): string {
    return JSON.stringify(this.state);
  }

  public static fromJson(key: string, json: string): PullRequestLifecycleStateV2 {
    const parsed = JSON.parse(json) as Partial<PrLifecycleState> & { testsTerminalEmittedForSha?: boolean };
    return new PullRequestLifecycleStateV2(key, {
      headSha: parsed.headSha ?? "",
      openedEmitted: parsed.openedEmitted ?? false,
      mergeConflictsEmittedForSha: parsed.mergeConflictsEmittedForSha ?? false,
      testsOutcomeEmittedForSha: parsed.testsOutcomeEmittedForSha ?? null,
      consecutiveEmptyScansForSha: parsed.consecutiveEmptyScansForSha ?? 0,
      mergedEmitted: parsed.mergedEmitted ?? false,
      terminal: parsed.terminal ?? false,
    });
  }

  // Maps a v1 row (written before the outcome field existed) onto the v2
  // shape. A v1 row that had latched a terminal tests verdict knows only that
  // SOME verdict was emitted, not which one. Mapping it to "failed" is the
  // safe approximation: the failed state keeps watching the SHA and only ever
  // emits pr.tests_succeeded, and emission is idempotent by producer event id
  // (SignalEventInteractor dedupes on (producerId, producerEventId)), so a
  // row whose original verdict was already "succeeded" converges with a
  // single deduplicated no-op instead of a duplicate event or a lost one.
  public static fromV1Json(key: string, json: string): PullRequestLifecycleStateV2 {
    const parsed = JSON.parse(json) as Partial<PrLifecycleState> & { testsTerminalEmittedForSha?: boolean };
    const outcome: EmittedTestsOutcome | null = parsed.testsTerminalEmittedForSha === true ? "failed" : null;
    return new PullRequestLifecycleStateV2(key, {
      headSha: parsed.headSha ?? "",
      openedEmitted: parsed.openedEmitted ?? false,
      mergeConflictsEmittedForSha: parsed.mergeConflictsEmittedForSha ?? false,
      testsOutcomeEmittedForSha: outcome,
      consecutiveEmptyScansForSha: parsed.consecutiveEmptyScansForSha ?? 0,
      mergedEmitted: parsed.mergedEmitted ?? false,
      terminal: parsed.terminal ?? false,
    });
  }
}
