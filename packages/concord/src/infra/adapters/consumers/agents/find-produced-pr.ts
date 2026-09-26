import type { WorktreeManager } from "../../../../domain/ports/out/worktree-manager";
import type { PullRequest } from "../../producers/github/pull-request";
import type { GitHubClient } from "../../producers/github/github-client";
import type { RepoRef } from "../../producers/github/github-client";

export interface FindProducedPullRequestDeps {
  readonly client: GitHubClient;
  readonly worktreeManager: WorktreeManager;
}

export interface FindProducedPullRequestInput {
  readonly repo: RepoRef;
  /** The branch the consuming handler expected the agent to work on (the
   * worktree's original branch name, before any agent rename). */
  readonly branch: string;
  readonly worktreePath: string;
}

/**
 * Finds the pull request an agent produced from a worktree, robust to the
 * agent renaming the branch before pushing (observed in production: fix
 * agents follow the target repo's branch-naming conventions and rename
 * `concord/<consumer>/...` to `fix/some-descriptive-name`, which made the
 * strict by-branch lookup report "did not produce a PR" for a PR that
 * existed — twice: runs 184b115f and efc7c068).
 *
 * Lookup order, first match wins:
 * 1. an open PR whose head is the expected branch (the fast path, unchanged
 *    behaviour when the agent did not rename);
 * 2. an open PR whose head is the worktree's *current* branch (the renamed
 *    name, still checked out in the worktree);
 * 3. an open PR whose head SHA equals the worktree's HEAD SHA (covers every
 *    other rename-and-push shape, including detached HEAD).
 */
export async function findProducedPullRequest(
  deps: FindProducedPullRequestDeps,
  input: FindProducedPullRequestInput,
): Promise<PullRequest | null> {
  const direct = await deps.client.findPullRequestByHead(input.repo, input.branch);
  if (direct !== null) {
    return direct;
  }
  let head = await deps.worktreeManager.currentHead(input.worktreePath);
  if (head.branch === input.branch) {
    head = { branch: null, sha: head.sha };
  }
  if (head.branch !== null) {
    const byCurrentBranch = await deps.client.findPullRequestByHead(input.repo, head.branch);
    if (byCurrentBranch !== null) {
      return byCurrentBranch;
    }
  }
  if (head.sha === null) {
    return null;
  }
  const open = await deps.client.listOpenPullRequests(input.repo);
  return open.find((pr) => pr.headSha === head.sha) ?? null;
}
