import type { GitHubClient, IssueComment, RepoRef, MergeMethod, ReviewEvent } from "../src/infra/adapters/producers/github/github-client";
import type { PullRequest } from "../src/infra/adapters/producers/github/pull-request";
import type { GithubIssue } from "../src/infra/adapters/producers/github/github-issue";
import type { CheckRun } from "../src/infra/adapters/producers/github/check-run";
import type { CheckSuite } from "../src/infra/adapters/producers/github/check-suite";
import type { WorktreeManager, SafeWorktreeRemovalOutcome } from "../src/domain/ports/out/worktree-manager";
import type { OpencodeRunner, OpencodeRunnerOptions } from "../src/domain/ports/out/opencode-runner";
import type { ConsumerConfigResolver } from "../src/domain/ports/out/consumer-config-resolver";
import type { ConsumerSecretResolver } from "../src/domain/ports/out/consumer-secret-resolver";
import type { ConsumerConfigSecrets, ConsumerConfigValues } from "../src/domain/component";
import type { ConsumerGitHubClientResolver, ResolvedGitHubIdentity } from "../src/infra/adapters/consumers/agents/consumer-github-client-resolver";
import type { GithubRepoEntry } from "../src/infra/adapters/producers/github/github-repos-context";

// Generic fakes for the engine's public machinery (git worktrees, the
// opencode runner, GitHub clients, config resolvers). Deployment packages
// keep their own copies tailored to their consumers.

export interface ExistingBranchCall {
  readonly entry: GithubRepoEntry;
  readonly branch: string;
}

export interface NewBranchCall {
  readonly entry: GithubRepoEntry;
  readonly newBranch: string;
  readonly baseBranch: string;
}

export class FakeWorktreeManager implements WorktreeManager {
  public readonly existingCalls: ExistingBranchCall[] = [];
  public readonly newCalls: NewBranchCall[] = [];
  public readonly removed: string[] = [];
  /** Paths reported as nonexistent by exists() — for ghost-hold tests. */
  public readonly absentPaths = new Set<string>();
  private readonly pathsByBranch: Map<string, string> = new Map();
  private shouldThrowOnExisting: unknown = null;
  private shouldThrowOnRemove: unknown = null;

  public constructor(private readonly rootPath: string = "/tmp/worktrees") {}

  public willReturnPath(branch: string, path: string): void {
    this.pathsByBranch.set(branch, path);
  }

  public willThrowOnExisting(error: unknown): void {
    this.shouldThrowOnExisting = error;
  }

  public willThrowOnRemove(error: unknown): void {
    this.shouldThrowOnRemove = error;
  }

  public async ensureForExistingBranch(entry: GithubRepoEntry, branch: string): Promise<string> {
    this.existingCalls.push({ entry, branch });
    if (this.shouldThrowOnExisting !== null) {
      throw this.shouldThrowOnExisting;
    }
    return this.pathFor(branch);
  }

  public async ensureForNewBranch(entry: GithubRepoEntry, newBranch: string, baseBranch: string): Promise<string> {
    this.newCalls.push({ entry, newBranch, baseBranch });
    return this.pathFor(newBranch);
  }

  public async exists(worktreePath: string): Promise<boolean> {
    return !this.absentPaths.has(worktreePath);
  }

  public readonly headStates = new Map<string, { branch: string | null; sha: string | null }>();

  /** Seeds the state currentHead() reports for a worktree path. */
  public willReportHead(worktreePath: string, branch: string | null, sha: string | null): void {
    this.headStates.set(worktreePath, { branch, sha });
  }

  public async currentHead(worktreePath: string): Promise<{ branch: string | null; sha: string | null }> {
    return this.headStates.get(worktreePath) ?? { branch: null, sha: null };
  }

  public async remove(worktreePath: string): Promise<void> {
    this.removed.push(worktreePath);
    if (this.shouldThrowOnRemove !== null) {
      throw this.shouldThrowOnRemove;
    }
  }

  public readonly safeRemovals: Array<{ readonly worktreePath: string; readonly note: string }> = [];
  public safeRemoveOutcome: SafeWorktreeRemovalOutcome = { status: "removed", stashed: false };

  public async safeRemove(
    worktreePath: string,
    note: string,
  ): Promise<SafeWorktreeRemovalOutcome> {
    this.safeRemovals.push({ worktreePath, note });
    // safeRemove's contract forbids throwing; a configured removal failure is
    // surfaced as a "skipped" outcome instead.
    if (this.shouldThrowOnRemove !== null) {
      return { status: "skipped", reason: "configured removal failure" };
    }
    return this.safeRemoveOutcome;
  }

  private pathFor(branch: string): string {
    const configured = this.pathsByBranch.get(branch);
    if (configured !== undefined) {
      return configured;
    }
    return `${this.rootPath}/${branch}`;
  }
}

export interface RunCall {
  readonly directory: string;
  readonly prompt: string;
  readonly options: OpencodeRunnerOptions;
  readonly signal: AbortSignal | undefined;
}

export interface RunStructuredCall {
  readonly directory: string;
  readonly prompt: string;
  readonly schema: object;
  readonly options: OpencodeRunnerOptions;
  readonly signal: AbortSignal | undefined;
}

export class FakeOpencodeRunner implements OpencodeRunner {
  public readonly runCalls: RunCall[] = [];
  public readonly runStructuredCalls: RunStructuredCall[] = [];
  private readonly structuredOutputs: Map<string, unknown> = new Map();
  private nextStructured: unknown = undefined;
  private runShouldThrow: unknown = null;

  public willReturnStructured(promptSubstring: string, output: unknown): void {
    this.structuredOutputs.set(promptSubstring, output);
  }

  public willReturnNextStructured(output: unknown): void {
    this.nextStructured = output;
  }

  public willThrowOnRun(error: unknown): void {
    this.runShouldThrow = error;
  }

  public async run(directory: string, prompt: string, options: OpencodeRunnerOptions, signal?: AbortSignal): Promise<void> {
    this.runCalls.push({ directory, prompt, options, signal });
    if (this.runShouldThrow !== null) {
      throw this.runShouldThrow;
    }
  }

  public async runStructured(directory: string, prompt: string, schema: object, options: OpencodeRunnerOptions, signal?: AbortSignal): Promise<unknown> {
    this.runStructuredCalls.push({ directory, prompt, schema, options, signal });
    for (const [substring, output] of this.structuredOutputs) {
      if (prompt.includes(substring)) {
        return output;
      }
    }
    return this.nextStructured;
  }
}

export interface MergeCall {
  readonly ref: RepoRef;
  readonly number: number;
  readonly method: MergeMethod;
}

export interface ReviewCall {
  readonly ref: RepoRef;
  readonly number: number;
  readonly event: ReviewEvent;
  readonly body: string;
}

export interface ListOpenIssuesCall {
  readonly ref: RepoRef;
  readonly labels: readonly string[] | undefined;
}

export class RecordingGitHubClient implements GitHubClient {
  public readonly comments: Array<{ ref: RepoRef; number: number; body: string }> = [];
  public readonly reviews: ReviewCall[] = [];
  public readonly merges: MergeCall[] = [];
  public readonly listIssueCommentsCalls: number[] = [];
  public readonly listOpenIssuesCalls: ListOpenIssuesCall[] = [];
  private readonly prsByHead: Map<string, PullRequest> = new Map();
  private readonly prsByRepo: Map<string, PullRequest[]> = new Map();
  private readonly prByRefNumber: Map<string, PullRequest> = new Map();
  private readonly issueCommentsByNumber: Map<string, IssueComment[]> = new Map();
  private readonly openIssuesByRepo: Map<string, GithubIssue[]> = new Map();
  private mergeShouldThrow: unknown = null;
  private listOpenIssuesShouldThrow: unknown = null;

  // Seeds the issues a listOpenIssues call returns. The fake does not model
  // per-issue labels: whatever is seeded is served for any label filter, the
  // same way the real client serves a server-side filtered list.
  public setOpenIssues(ref: RepoRef, issues: GithubIssue[]): void {
    this.openIssuesByRepo.set(`${ref.owner}/${ref.repo}`, issues);
  }

  public willThrowOnListOpenIssues(error: unknown): void {
    this.listOpenIssuesShouldThrow = error;
  }

  public setIssueComments(ref: RepoRef, number: number, comments: IssueComment[]): void {
    this.issueCommentsByNumber.set(`${ref.owner}/${ref.repo}#${number}`, comments);
  }

  public setPullRequests(ref: RepoRef, prs: PullRequest[]): void {
    this.prsByRepo.set(`${ref.owner}/${ref.repo}`, prs);
  }

  public setPullRequest(ref: RepoRef, number: number, pr: PullRequest): void {
    this.prByRefNumber.set(`${ref.owner}/${ref.repo}#${number}`, pr);
  }

  public setPullRequestByHead(ref: RepoRef, headBranch: string, pr: PullRequest | null): void {
    if (pr === null) {
      this.prsByHead.delete(`${ref.owner}/${ref.repo}:${headBranch}`);
    } else {
      this.prsByHead.set(`${ref.owner}/${ref.repo}:${headBranch}`, pr);
    }
  }

  public willThrowOnMerge(error: unknown): void {
    this.mergeShouldThrow = error;
  }

  public async listOpenPullRequests(ref: RepoRef): Promise<readonly PullRequest[]> {
    return [...(this.prsByRepo.get(`${ref.owner}/${ref.repo}`) ?? [])];
  }

  public async getPullRequest(ref: RepoRef, number: number): Promise<PullRequest> {
    const found = this.prByRefNumber.get(`${ref.owner}/${ref.repo}#${number}`);
    if (found === undefined) {
      throw new Error(`RecordingGitHubClient has no PR ${ref.owner}/${ref.repo}#${number}`);
    }
    return found;
  }

  public async listCheckRuns(): Promise<readonly CheckRun[]> {
    return [];
  }

  public async listCheckSuites(_ref: RepoRef, _headSha: string): Promise<readonly CheckSuite[]> {
    return [];
  }

  public async listOpenIssues(ref: RepoRef, labels?: readonly string[]): Promise<readonly GithubIssue[]> {
    this.listOpenIssuesCalls.push({ ref, labels });
    if (this.listOpenIssuesShouldThrow !== null) {
      throw this.listOpenIssuesShouldThrow;
    }
    return [...(this.openIssuesByRepo.get(`${ref.owner}/${ref.repo}`) ?? [])];
  }

  public async listIssueComments(ref: RepoRef, number: number): Promise<readonly IssueComment[]> {
    this.listIssueCommentsCalls.push(number);
    return [...(this.issueCommentsByNumber.get(`${ref.owner}/${ref.repo}#${number}`) ?? [])];
  }

  public async createIssueComment(ref: RepoRef, number: number, body: string): Promise<void> {
    this.comments.push({ ref, number, body });
  }

  public async createReview(ref: RepoRef, number: number, event: ReviewEvent, body: string): Promise<void> {
    this.reviews.push({ ref, number, event, body });
  }

  public async findPullRequestByHead(ref: RepoRef, headBranch: string): Promise<PullRequest | null> {
    return this.prsByHead.get(`${ref.owner}/${ref.repo}:${headBranch}`) ?? null;
  }

  public async mergePullRequest(ref: RepoRef, number: number, method: MergeMethod): Promise<void> {
    this.merges.push({ ref, number, method });
    if (this.mergeShouldThrow !== null) {
      throw this.mergeShouldThrow;
    }
  }
}

export class FakeConsumerConfigResolver implements ConsumerConfigResolver {
  public constructor(private readonly values: ConsumerConfigValues = {}) {}

  public async resolve(_consumerId: string): Promise<ConsumerConfigValues> {
    return { ...this.values };
  }
}

export class FakeConsumerSecretResolver implements ConsumerSecretResolver {
  public constructor(private readonly secrets: ConsumerConfigSecrets = {}) {}

  public async resolveSecrets(_consumerId: string): Promise<ConsumerConfigSecrets> {
    return { ...this.secrets };
  }
}

export class RecordingConsumerGitHubClientResolver implements ConsumerGitHubClientResolver {
  public readonly resolveCalls: string[] = [];

  public constructor(
    private readonly client: GitHubClient,
    private readonly token: string | null = null,
  ) {}

  public async resolve(consumerId: string): Promise<ResolvedGitHubIdentity> {
    this.resolveCalls.push(consumerId);
    return { client: this.client, token: this.token };
  }
}

export function repoEntry(overrides: Partial<GithubRepoEntry> = {}): GithubRepoEntry {
  return {
    name: "example",
    url: "https://github.com/example/example",
    local: "/repos/example",
    worktrees: "/repos/example/.worktrees",
    ...overrides,
  };
}
