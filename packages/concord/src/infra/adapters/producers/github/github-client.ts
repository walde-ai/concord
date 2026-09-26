import { UnexpectedStateError } from "../../../../domain/exceptions/errors";
import type { PullRequest } from "./pull-request";
import type { GithubIssue } from "./github-issue";
import type { CheckRun } from "./check-run";
import type { CheckSuite } from "./check-suite";

export interface RepoRef {
  readonly owner: string;
  readonly repo: string;
}

export type MergeMethod = "merge" | "squash" | "rebase";

export type ReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

export function parseRepoRef(url: string): RepoRef {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UnexpectedStateError(`Invalid repository URL: ${url}`);
  }

  if (parsed.hostname !== "github.com" && parsed.hostname !== "www.github.com") {
    throw new UnexpectedStateError(`Not a GitHub URL: ${url}`);
  }

  const segments = parsed.pathname.split("/").filter((segment) => segment.length > 0);
  if (segments.length < 2) {
    throw new UnexpectedStateError(`GitHub URL is missing owner/repo: ${url}`);
  }

  const owner = segments[0];
  const repo = segments[1].replace(/\.git$/, "");
  if (owner.length === 0 || repo.length === 0) {
    throw new UnexpectedStateError(`GitHub URL has empty owner or repo: ${url}`);
  }
  return { owner, repo };
}

export interface IssueComment {
  readonly id: number;
  readonly author: string;
  readonly body: string;
  readonly createdAt: string;
}

export interface GitHubClient {
  listOpenPullRequests(ref: RepoRef): Promise<readonly PullRequest[]>;
  getPullRequest(ref: RepoRef, number: number): Promise<PullRequest>;
  listCheckRuns(ref: RepoRef, headSha: string): Promise<readonly CheckRun[]>;
  listCheckSuites(ref: RepoRef, headSha: string): Promise<readonly CheckSuite[]>;
  listOpenIssues(ref: RepoRef, labels?: readonly string[]): Promise<readonly GithubIssue[]>;
  listIssueComments(ref: RepoRef, number: number): Promise<readonly IssueComment[]>;
  createIssueComment(ref: RepoRef, number: number, body: string): Promise<void>;
  createReview(ref: RepoRef, number: number, event: ReviewEvent, body: string): Promise<void>;
  findPullRequestByHead(ref: RepoRef, headBranch: string): Promise<PullRequest | null>;
  mergePullRequest(ref: RepoRef, number: number, method: MergeMethod): Promise<void>;
}
