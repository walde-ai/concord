export const PR_OPENED = "pr.opened";
export const PR_MERGE_CONFLICTS = "pr.merge_conflicts";
export const PR_TESTS_FAILED = "pr.tests_failed";
export const PR_TESTS_SUCCEEDED = "pr.tests_succeeded";
export const PR_VALIDATION_FAILED = "pr.validation_failed";
export const PR_VALIDATION_SUCCEEDED = "pr.validation_succeeded";
export const PR_MERGED = "pr.merged";
export const PR_MISSING = "pr.missing";

export interface RepoRefDto {
  readonly owner: string;
  readonly repo: string;
  readonly url: string;
}

export interface PrEventPayload {
  readonly repo: RepoRefDto;
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly author: string;
  readonly draft: boolean;
  readonly headSha: string;
  readonly headRef: string;
}

export interface PrOpenedPayload extends PrEventPayload {
  readonly createdAt: string;
}

export interface PrMergeConflictsPayload extends PrEventPayload {
  readonly mergeableState: string;
}

export interface CheckRunSummary {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
}

export interface PrTestsSucceededPayload extends PrEventPayload {
  readonly checkRuns: readonly CheckRunSummary[];
}

export interface PrTestsFailedPayload extends PrEventPayload {
  readonly checkRuns: readonly CheckRunSummary[];
  readonly failedRuns: readonly CheckRunSummary[];
}

export interface PrValidationSucceededPayload extends PrEventPayload {
  readonly validatedBy: string;
  readonly message: string;
}

export interface PrValidationFailedPayload extends PrEventPayload {
  readonly reason: string;
  readonly validatedBy: string;
}

export interface PrMergedPayload extends PrEventPayload {
  readonly mergedAt: string;
}

export interface PrMissingPayload {
  readonly repo: RepoRefDto;
  readonly branch: string;
  readonly worktreePath: string;
  readonly source: string;
}

export class PullRequest {
  public constructor(
    public readonly number: number,
    public readonly title: string,
    public readonly url: string,
    public readonly author: string,
    public readonly repoFullName: string,
    public readonly draft: boolean,
    public readonly createdAt: Date,
    public readonly headSha: string,
    public readonly mergeableState: string,
    public readonly state: string,
    public readonly merged: boolean,
    public readonly headRef: string,
  ) {}
}
