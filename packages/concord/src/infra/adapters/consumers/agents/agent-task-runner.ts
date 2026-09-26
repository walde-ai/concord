import type { RepoRef } from "../../producers/github/github-client";
import type { WorktreeManager } from "../../../../domain/ports/out/worktree-manager";
import type { OpencodeRunner, OpencodeRunnerOptions } from "../../../../domain/ports/out/opencode-runner";
import type { ConsumerConfigResolver } from "../../../../domain/ports/out/consumer-config-resolver";
import type { ConsumerGitHubClientResolver } from "./consumer-github-client-resolver";
import type { WorktreeLeases } from "../../git/worktree-lease-registry";

import { RepoEntryLookup } from "./repo-entry-lookup";
import { findProducedPullRequest } from "./find-produced-pr";

export type BranchSpecification =
  | { readonly kind: "existing"; readonly branch: string }
  | { readonly kind: "new"; readonly newBranch: string; readonly baseBranch: string };

export interface CodeProducingRequest {
  readonly consumerId: string;
  readonly runId: string;
  readonly repo: RepoRef;
  readonly branch: BranchSpecification;
  readonly prompt: string;
  readonly source: string;
  // When set, the agent session runs with a structured output schema and the
  // parsed output is returned alongside the code-producing outcome, so a
  // caller can both check the pushed-commit signal and read a verdict (used by
  // consumers to detect structured verdicts mid-run).
  readonly schema?: object;
}

export type CodeProducingResult =
  | { readonly ok: true; readonly prExists: boolean; readonly headSha: string | null; readonly branch: string; readonly worktreePath: string; readonly output: unknown }
  | { readonly ok: false; readonly reason: "repo-not-found" };

export interface ReviewRequest {
  readonly consumerId: string;
  readonly runId: string;
  readonly repo: RepoRef;
  readonly branch: string;
  readonly prompt: string;
  readonly schema: object;
}

export type ReviewResult =
  | { readonly ok: true; readonly output: unknown }
  | { readonly ok: false; readonly reason: "repo-not-found" };

export class AgentTaskRunner {
  public constructor(
    private readonly repoLookup: RepoEntryLookup,
    private readonly worktreeManager: WorktreeManager,
    private readonly runner: OpencodeRunner,
    private readonly gitHubClientResolver: ConsumerGitHubClientResolver,
    private readonly configResolver: ConsumerConfigResolver,
    private readonly worktreeLeases?: WorktreeLeases,
  ) {}

  public async runCodeProducingTask(request: CodeProducingRequest, signal?: AbortSignal): Promise<CodeProducingResult> {
    const entry = await this.repoLookup.find(request.repo.owner, request.repo.repo);
    if (entry === null) {
      return { ok: false, reason: "repo-not-found" };
    }
    const branch = resolveBranch(request.branch);
    const worktreePath = await ensureWorktree(this.worktreeManager, entry, request.branch, signal);
    // The worktree is now run-scoped: when this run reaches a terminal state
    // (however it ends), the lease registry reclaims it — stashing any
    // uncommitted work first — instead of leaking the checkout forever.
    this.worktreeLeases?.track(request.runId, worktreePath);
    const { client, token } = await this.gitHubClientResolver.resolve(request.consumerId);
    const options = await this.optionsFor(request.consumerId, request.runId, token);
    let output: unknown = null;
    if (request.schema === undefined) {
      await this.runner.run(worktreePath, request.prompt, options, signal);
    } else {
      output = await this.runner.runStructured(worktreePath, request.prompt, request.schema, options, signal);
    }
    const match = await findProducedPullRequest(
      { client, worktreeManager: this.worktreeManager },
      { repo: request.repo, branch, worktreePath },
    );
    return { ok: true, prExists: match !== null, headSha: match?.headSha ?? null, branch, worktreePath, output };
  }

  public async runReviewTask(request: ReviewRequest, signal?: AbortSignal): Promise<ReviewResult> {
    const entry = await this.repoLookup.find(request.repo.owner, request.repo.repo);
    if (entry === null) {
      return { ok: false, reason: "repo-not-found" };
    }
    const worktreePath = await this.worktreeManager.ensureForExistingBranch(entry, request.branch, { signal });
    this.worktreeLeases?.track(request.runId, worktreePath);
    const output = await this.runner.runStructured(
      worktreePath,
      request.prompt,
      request.schema,
      await this.optionsFor(request.consumerId, request.runId, null),
      signal,
    );
    return { ok: true, output };
  }

  /**
   * Marks a worktree this run created as handed off to a FUTURE run: its path
   * rides a PR-missing event payload that the publishing consumer uses to
   * publish (and then removes the worktree itself). Call this immediately
   * before emitting the event; run-end cleanup then deliberately keeps the
   * worktree so the receiving run finds it intact.
   */
  public handoffWorktree(worktreePath: string): void {
    this.worktreeLeases?.handoff(worktreePath);
  }

  private async optionsFor(consumerId: string, runId: string, githubToken: string | null): Promise<OpencodeRunnerOptions> {
    const values = await this.configResolver.resolve(consumerId);
    const options: OpencodeRunnerOptions = {
      agentId: values.agentName ?? "",
      modelId: values.modelId ?? "",
      runId,
      consumerId,
      maxInputRounds: resolveMaxInputRounds(values.maxInputRounds),
    };
    if (githubToken !== null) {
      return { ...options, githubToken };
    }
    return options;
  }
}

function resolveMaxInputRounds(raw: string | undefined): number {
  if (raw === undefined || raw.length === 0) {
    return 0;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return 0;
  }
  return parsed;
}

function resolveBranch(spec: BranchSpecification): string {
  if (spec.kind === "existing") {
    return spec.branch;
  }
  return spec.newBranch;
}

async function ensureWorktree(
  manager: WorktreeManager,
  entry: Parameters<typeof manager.ensureForExistingBranch>[0],
  spec: BranchSpecification,
  signal?: AbortSignal,
): Promise<string> {
  if (spec.kind === "existing") {
    return manager.ensureForExistingBranch(entry, spec.branch, { signal });
  }
  return manager.ensureForNewBranch(entry, spec.newBranch, spec.baseBranch, { signal });
}
