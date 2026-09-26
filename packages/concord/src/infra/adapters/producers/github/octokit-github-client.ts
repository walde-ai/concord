import { Octokit } from "@octokit/rest";

import type { GitHubClient, IssueComment, RepoRef, MergeMethod, ReviewEvent } from "./github-client";
import { PullRequest } from "./pull-request";
import { GithubIssue } from "./github-issue";
import { CheckRun } from "./check-run";
import { CheckSuite } from "./check-suite";
import {
  createTimeoutFetch,
  withGitHubRetry,
  DEFAULT_GITHUB_RETRY_OPTIONS,
  type GitHubRetryOptions,
} from "./github-retry";

const GITHUB_ACTIONS_APP_SLUG = "github-actions";

export class OctokitGitHubClient implements GitHubClient {
  private readonly octokit: Octokit;
  private readonly retry: GitHubRetryOptions;

  public constructor(token: string, retry: GitHubRetryOptions = DEFAULT_GITHUB_RETRY_OPTIONS) {
    // The GitHub REST API is reached over the public internet and, on hosts
    // with an unreliable connection, transient failures (DNS, refused/reset
    // connections, connect timeouts, 5xx/429) are frequent. Each HTTP request
    // is bounded by a timeout (so a stalled response cannot hang the caller)
    // and each operation is retried with backoff so a one-off blip is
    // recovered instead of failing the producer scan or the handler outright.
    this.octokit = new Octokit({ auth: token, request: { fetch: createTimeoutFetch() } });
    this.retry = retry;
  }

  public async listOpenPullRequests(ref: RepoRef): Promise<readonly PullRequest[]> {
    const items = await this.send(() =>
      this.octokit.paginate(this.octokit.rest.pulls.list, {
        owner: ref.owner,
        repo: ref.repo,
        state: "open",
        per_page: 100,
      }),
    );
    return items.map((item) => this.toPullRequest(item as OctokitPullRequest, ref));
  }

  public async getPullRequest(ref: RepoRef, number: number): Promise<PullRequest> {
    const response = await this.send(() =>
      this.octokit.rest.pulls.get({
        owner: ref.owner,
        repo: ref.repo,
        pull_number: number,
      }),
    );
    return this.toPullRequest(response.data as OctokitPullRequest, ref);
  }

  public async listCheckRuns(ref: RepoRef, headSha: string): Promise<readonly CheckRun[]> {
    const response = await this.send(() =>
      this.octokit.rest.checks.listForRef({
        owner: ref.owner,
        repo: ref.repo,
        ref: headSha,
        per_page: 100,
      }),
    );
    return response.data.check_runs
      .filter((run) => run.app !== null && run.app !== undefined && run.app.slug === GITHUB_ACTIONS_APP_SLUG)
      .map((run) => new CheckRun(run.name, run.status, run.conclusion));
  }

  public async listCheckSuites(ref: RepoRef, headSha: string): Promise<readonly CheckSuite[]> {
    const response = await this.send(() =>
      this.octokit.rest.checks.listSuitesForRef({
        owner: ref.owner,
        repo: ref.repo,
        ref: headSha,
        per_page: 100,
      }),
    );
    return response.data.check_suites
      .filter((suite) => suite.app !== null && suite.app !== undefined && suite.app.slug === GITHUB_ACTIONS_APP_SLUG)
      .map((suite) => new CheckSuite(suite.status, suite.conclusion));
  }

  public async listOpenIssues(ref: RepoRef, labels?: readonly string[]): Promise<readonly GithubIssue[]> {
    const items = await this.send(() =>
      this.octokit.paginate(this.octokit.rest.issues.listForRepo, {
        owner: ref.owner,
        repo: ref.repo,
        state: "open",
        per_page: 100,
        ...(labels !== undefined && labels.length > 0 ? { labels: labels.join(",") } : {}),
      }),
    );
    return items
      .filter((item) => {
        const pullRequest = (item as { pull_request?: unknown }).pull_request;
        return pullRequest === undefined || pullRequest === null;
      })
      .map((item) => new GithubIssue(item.number, item.title, item.html_url));
  }

  public async listIssueComments(ref: RepoRef, number: number): Promise<readonly IssueComment[]> {
    const items = await this.send(() =>
      this.octokit.paginate(this.octokit.rest.issues.listComments, {
        owner: ref.owner,
        repo: ref.repo,
        issue_number: number,
        per_page: 100,
      }),
    );
    return items.map((item) => ({
      id: item.id,
      author: item.user?.login ?? "",
      body: item.body ?? "",
      createdAt: item.created_at ?? "",
    }));
  }

  public async createIssueComment(ref: RepoRef, number: number, body: string): Promise<void> {
    await this.send(() =>
      this.octokit.rest.issues.createComment({
        owner: ref.owner,
        repo: ref.repo,
        issue_number: number,
        body,
      }),
    );
  }

  public async createReview(ref: RepoRef, number: number, event: ReviewEvent, body: string): Promise<void> {
    await this.send(() =>
      this.octokit.rest.pulls.createReview({
        owner: ref.owner,
        repo: ref.repo,
        pull_number: number,
        event,
        body,
      }),
    );
  }

  public async findPullRequestByHead(ref: RepoRef, headBranch: string): Promise<PullRequest | null> {
    const response = await this.send(() =>
      this.octokit.rest.pulls.list({
        owner: ref.owner,
        repo: ref.repo,
        state: "open",
        head: `${ref.owner}:${headBranch}`,
        per_page: 1,
      }),
    );
    const items = response.data;
    if (items.length === 0) {
      return null;
    }
    return this.toPullRequest(items[0] as OctokitPullRequest, ref);
  }

  public async mergePullRequest(ref: RepoRef, number: number, method: MergeMethod): Promise<void> {
    await this.send(() =>
      this.octokit.rest.pulls.merge({
        owner: ref.owner,
        repo: ref.repo,
        pull_number: number,
        merge_method: method,
      }),
    );
  }

  private async send<T>(operation: () => Promise<T>): Promise<T> {
    return withGitHubRetry(operation, this.retry);
  }

  private toPullRequest(item: OctokitPullRequest, ref: RepoRef): PullRequest {
    const author = item.user !== null && item.user !== undefined ? item.user.login : "ghost";
    const head = item.head;
    const headSha = head !== null && head !== undefined && head.sha !== null && head.sha !== undefined
      ? head.sha
      : "";
    const headRef = head !== null && head !== undefined && typeof head.ref === "string" ? head.ref : "";
    return new PullRequest(
      item.number,
      item.title,
      item.html_url,
      author,
      `${ref.owner}/${ref.repo}`,
      item.draft ?? false,
      new Date(item.created_at),
      headSha,
      item.mergeable_state ?? "unknown",
      item.state,
      item.merged ?? false,
      headRef,
    );
  }
}

interface OctokitPullRequest {
  number: number;
  title: string;
  html_url: string;
  user: { login: string } | null | undefined;
  draft: boolean | null | undefined;
  created_at: string;
  state: string;
  merged?: boolean | null | undefined;
  mergeable_state?: string | null | undefined;
  head?: { sha?: string | null | undefined; ref?: string | null | undefined } | null | undefined;
}
