import { describe, it, expect } from "vitest";

import { fetchAuthoritativeMergeableState } from "../src/infra/adapters/producers/github/mergeable-state";
import type { GitHubClient, RepoRef } from "../src/infra/adapters/producers/github/github-client";
import type { PullRequest } from "../src/infra/adapters/producers/github/pull-request";
import { PullRequest as PullRequestClass } from "../src/infra/adapters/producers/github/pull-request";

const ref: RepoRef = { owner: "example-corp", repo: "app" };

function pr(mergeableState: string): PullRequest {
  return new PullRequestClass(
    42,
    "Add feature",
    "https://github.com/example-corp/app/pull/42",
    "alice",
    "example-corp/app",
    false,
    new Date("2026-07-01T00:00:00Z"),
    "deadbeef",
    mergeableState,
    "open",
    false,
    "feature/add-thing",
  );
}

// A minimal fake that returns a canned mergeable_state from getPullRequest and
// records whether getPullRequest was called, so tests can assert the helper
// only hits pulls.get when the list value is the placeholder "unknown".
class StubClient implements GitHubClient {
  public getPullRequestCalls = 0;

  public constructor(private readonly authoritative: string) {}

  public async getPullRequest(): Promise<PullRequest> {
    this.getPullRequestCalls += 1;
    return pr(this.authoritative);
  }

  // The remaining methods are unused by the helper but required by the
  // GitHubClient interface.
  public async listOpenPullRequests(): Promise<readonly PullRequest[]> {
    return [];
  }
  public async listCheckRuns(): Promise<readonly never[]> {
    return [];
  }
  public async listCheckSuites(): Promise<readonly never[]> {
    return [];
  }
  public async listOpenIssues(): Promise<readonly never[]> {
    return [];
  }
  public async createIssueComment(): Promise<void> {}
  public async createReview(): Promise<void> {}
  public async findPullRequestByHead(): Promise<PullRequest | null> {
    return null;
  }
  public async mergePullRequest(): Promise<void> {}
}

describe("fetchAuthoritativeMergeableState", () => {
  it("returns the supplied value unchanged when it is definitive and skips pulls.get", async () => {
    const client = new StubClient("dirty");

    const result = await fetchAuthoritativeMergeableState(client, ref, pr("dirty"));

    expect(result).toBe("dirty");
    expect(client.getPullRequestCalls).toBe(0);
  });

  it("resolves via pulls.get when the supplied value is unknown", async () => {
    const client = new StubClient("dirty");

    const result = await fetchAuthoritativeMergeableState(client, ref, pr("unknown"));

    expect(result).toBe("dirty");
    expect(client.getPullRequestCalls).toBe(1);
  });

  it("returns whatever pulls.get reports, including a still-unknown verdict", async () => {
    const client = new StubClient("unknown");

    const result = await fetchAuthoritativeMergeableState(client, ref, pr("unknown"));

    expect(result).toBe("unknown");
  });

  it("propagates the error when the authoritative fetch itself fails", async () => {
    const client = new StubClient("dirty");
    const failing: GitHubClient = {
      ...client,
      getPullRequest: async () => {
        throw new Error("boom");
      },
    };

    await expect(fetchAuthoritativeMergeableState(failing, ref, pr("unknown"))).rejects.toThrow("boom");
  });
});
