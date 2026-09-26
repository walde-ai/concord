import type { PrLifecycleState } from "../../../producers/github/pull-request-lifecycle-store";

// Persists the GitHub PR producer's per-PR lifecycle state so a server restart
// does not lose it. Without durability the producer re-discovers every open PR
// on startup, finds no recorded state, and re-emits pr.opened for each —
// retriggering downstream consumers and producing duplicate noise. The whole
// state object is serialised as a single JSON blob: it is small, read/written
// atomically as a unit, and adding a field later only needs a DTO bump.
export class PullRequestLifecycleStateV1 {
  public static readonly version = "v1";

  public constructor(
    public readonly key: string,
    public readonly state: PrLifecycleState,
  ) {}

  public toJson(): string {
    return JSON.stringify(this.state);
  }

  public static fromJson(key: string, json: string): PullRequestLifecycleStateV1 {
    const parsed = JSON.parse(json) as PrLifecycleState;
    return new PullRequestLifecycleStateV1(key, parsed);
  }
}
