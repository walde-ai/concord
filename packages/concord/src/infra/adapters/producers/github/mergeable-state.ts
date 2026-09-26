import type { GitHubClient, RepoRef } from "./github-client";
import type { PullRequest } from "./pull-request";

// GitHub computes `mergeable_state` asynchronously. The `pulls.list` endpoint
// frequently serves the placeholder `"unknown"` — sometimes transiently in the
// second after a push, and sometimes persistently until the pull request is
// fetched individually. `"unknown"` is not a verdict: it means GitHub has not
// yet computed mergeability, and a PR that actually has file-level conflicts
// can be reported as `"unknown"` rather than `"dirty"` for an arbitrarily long
// time. Relying on the list value alone therefore silently drops
// `pr.merge_conflicts` events for genuinely conflicted PRs.
//
// `pulls.get` triggers GitHub's mergeability computation and is the documented
// authoritative source, so when the supplied value is `"unknown"` this helper
// fetches the PR individually and returns that value. When the supplied value
// is already definitive it is returned unchanged, so the extra request is made
// only when it can change the outcome.
//
// The helper throws only if the authoritative fetch itself fails, leaving the
// caller free to decide how to surface that failure (the producer logs and
// retries on the next scan; the verify handler turns it into a run failure).
export async function fetchAuthoritativeMergeableState(
  client: GitHubClient,
  ref: RepoRef,
  pr: PullRequest,
): Promise<string> {
  if (pr.mergeableState !== "unknown") {
    return pr.mergeableState;
  }
  const fresh = await client.getPullRequest(ref, pr.number);
  return fresh.mergeableState;
}
