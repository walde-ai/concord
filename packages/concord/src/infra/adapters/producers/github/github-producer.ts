import type { Producer } from "../../../../domain/ports/in/producer";
import type { EventSink } from "../../../../domain/ports/in/event-sink";
import type { Registration } from "../../../../domain/ports/in/registration";
import { Event } from "../../../../domain/entities/event";
import type { IdGenerator } from "../../../../domain/ports/out/id-generator";
import type { Clock } from "../../../../domain/ports/out/clock";
import type { ContextResolver } from "../../../../domain/ports/out/context-resolver";
import type { Logger } from "../../../../domain/ports/out/logger";
import { UnexpectedStateError } from "../../../../domain/exceptions/errors";

import type { GitHubClient, RepoRef } from "./github-client";
import { parseRepoRef } from "./github-client";
import type { PullRequestLifecycleStore, PrLifecycleState } from "./pull-request-lifecycle-store";
import type { CheckRun } from "./check-run";
import {
  GITHUB_REPOS_CONTEXT,
  isGithubReposContextPayload,
  type GithubRepoEntry,
} from "./github-repos-context";
import {
  PullRequest,
  PR_OPENED,
  PR_MERGE_CONFLICTS,
  PR_TESTS_SUCCEEDED,
  PR_TESTS_FAILED,
  PR_MERGED,
  type PrEventPayload,
  type PrOpenedPayload,
  type PrMergeConflictsPayload,
  type PrTestsSucceededPayload,
  type PrTestsFailedPayload,
  type PrMergedPayload,
  type CheckRunSummary,
} from "./pull-request";
import { fetchAuthoritativeMergeableState } from "./mergeable-state";

const FAILURE_CONCLUSIONS: ReadonlySet<string> = new Set(["failure", "cancelled", "timed_out"]);

// When a head SHA has neither check runs nor check suites, the producer cannot
// immediately tell whether GitHub Actions has not yet had time to register the
// first workflow run for the push (the brief, sub-second window between the
// push and Actions creating the first check suite) or whether the repository
// genuinely has no Actions configured. To keep "no tests configured" working
// without misfiring on the race, the producer waits this many consecutive
// empty scans before treating the SHA as test-less. With the default 10-second
// poll interval this is roughly one minute of grace, which is far longer than
// Actions takes to create a check suite but short enough that a test-less
// repository does not block validation indefinitely.
const DEFAULT_EMPTY_SCANS_BEFORE_NO_TESTS = 6;

export class GithubPrProducer implements Producer {
  public readonly producerId = "github-pr";

  private idGenerator: IdGenerator | null = null;
  private clock: Clock | null = null;
  private contexts: ContextResolver | null = null;
  private sink: EventSink | null = null;
  private timer: NodeJS.Timeout | null = null;
  private scanning = false;

  public constructor(
    private readonly client: GitHubClient,
    private readonly store: PullRequestLifecycleStore,
    private readonly pollIntervalMs: number,
    private readonly logger: Logger,
    private readonly emptyScansBeforeNoTests: number = DEFAULT_EMPTY_SCANS_BEFORE_NO_TESTS,
  ) {}

  public register(registration: Registration): void {
    this.idGenerator = registration.idGenerator;
    this.clock = registration.clock;
    this.contexts = registration.contexts;
    registration.addProducer(this);
  }

  public async start(sink: EventSink): Promise<void> {
    this.requireRegistered();
    this.sink = sink;
    await this.scan();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.pollIntervalMs);
  }

  public async stop(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.sink = null;
  }

  private async tick(): Promise<void> {
    if (this.scanning) {
      return;
    }
    await this.scan();
  }

  private async scan(): Promise<void> {
    this.requireRegistered();
    const contexts = this.contexts;
    if (contexts === null) {
      throw new UnexpectedStateError("GithubPrProducer has not been registered");
    }

    this.scanning = true;
    try {
      const result = await contexts.resolve(
        { kind: "producer", id: this.producerId },
        GITHUB_REPOS_CONTEXT,
        isGithubReposContextPayload,
      );
      if (!result.ok) {
        this.logger.error("github-producer", "context unavailable", {
          context: GITHUB_REPOS_CONTEXT,
          error: result.error.message,
        });
        return;
      }
      const openKeys: Set<string> = new Set();
      for (const entry of result.value.context.repos) {
        await this.scanRepo(entry, openKeys);
      }
      await this.detectDisappeared(openKeys);
    } finally {
      this.scanning = false;
    }
  }

  private async scanRepo(entry: GithubRepoEntry, openKeys: Set<string>): Promise<void> {
    let ref: RepoRef;
    try {
      ref = parseRepoRef(entry.url);
    } catch (cause) {
      this.logger.error("github-producer", "skipping repo with invalid URL", {
        repo: entry.name,
        url: entry.url,
        error: describeCause(cause),
      });
      return;
    }

    let pullRequests: readonly PullRequest[];
    try {
      pullRequests = await this.client.listOpenPullRequests(ref);
    } catch (cause) {
      this.logger.error("github-producer", "failed to list pull requests", {
        owner: ref.owner,
        repo: ref.repo,
        error: describeCause(cause),
      });
      return;
    }

    for (const pr of pullRequests) {
      const key = `${pr.repoFullName}#${pr.number}`;
      openKeys.add(key);
      try {
        await this.visitOpenPr(pr, ref, entry.url, key);
      } catch (cause) {
        this.logger.error("github-producer", "failed while visiting PR", {
          key,
          error: describeCause(cause),
        });
      }
    }
  }

  private async visitOpenPr(
    pr: PullRequest,
    ref: RepoRef,
    repoUrl: string,
    key: string,
  ): Promise<void> {
    let state = await this.store.get(key);

    if (state === null) {
      await this.emitOpened(pr, ref, repoUrl);
      state = {
        headSha: pr.headSha,
        openedEmitted: true,
        mergeConflictsEmittedForSha: false,
        testsTerminalEmittedForSha: false,
        consecutiveEmptyScansForSha: 0,
        mergedEmitted: false,
        terminal: false,
      };
      await this.store.save(key, state);
    } else {
      if (state.terminal) {
        return;
      }
      if (pr.headSha !== state.headSha) {
        state = {
          ...state,
          headSha: pr.headSha,
          mergeConflictsEmittedForSha: false,
          testsTerminalEmittedForSha: false,
          consecutiveEmptyScansForSha: 0,
        };
        await this.store.save(key, state);
      }
    }

    if (!state.mergeConflictsEmittedForSha) {
      // GitHub computes mergeable_state asynchronously and the pulls.list
      // endpoint frequently reports "unknown" for genuinely conflicted PRs,
      // which would silently drop pr.merge_conflicts. Resolve the authoritative
      // value before deciding. A failure to resolve is logged and retried on
      // the next scan rather than failing the whole producer.
      const mergeableState = await this.resolveMergeableState(pr, ref);
      if (mergeableState === "dirty") {
        await this.emitMergeConflicts(pr, ref, repoUrl, mergeableState);
        state = { ...state, mergeConflictsEmittedForSha: true };
        await this.store.save(key, state);
      }
    }

    if (!state.testsTerminalEmittedForSha) {
      const decision = await this.decideTests(pr, ref, state);
      if (decision.kind === "emit-succeeded") {
        await this.emitTestsSucceeded(pr, ref, repoUrl, decision.runs);
        state = { ...state, testsTerminalEmittedForSha: true, consecutiveEmptyScansForSha: 0 };
        await this.store.save(key, state);
      } else if (decision.kind === "emit-failed") {
        await this.emitTestsFailed(pr, ref, repoUrl, decision.runs, decision.failed);
        state = { ...state, testsTerminalEmittedForSha: true, consecutiveEmptyScansForSha: 0 };
        await this.store.save(key, state);
      } else if (decision.kind === "wait") {
        if (decision.emptyScans !== state.consecutiveEmptyScansForSha) {
          state = { ...state, consecutiveEmptyScansForSha: decision.emptyScans };
          await this.store.save(key, state);
        }
      } else {
        // pending: nothing to persist this scan, wait for the next one
      }
    }
  }

  // decideTests maps the current GitHub state for the SHA into one of three
  // producer actions. The trick is the empty case: GitHub Actions creates a
  // check suite within a second or two of a push, but there is a sub-second
  // window where neither check runs nor check suites exist for the new commit.
  // Treating that window as "no tests configured" — which is what the original
  // implementation did — misfires `pr.tests_succeeded` on every fast push. To
  // stay correct in both cases the producer requires both signals to be empty
  // for several consecutive scans before concluding the repository has no
  // Actions configured; as long as a check suite exists, it waits for the runs
  // to appear.
  private async decideTests(
    pr: PullRequest,
    ref: RepoRef,
    state: PrLifecycleState,
  ): Promise<
    | { readonly kind: "emit-succeeded"; readonly runs: readonly CheckRun[] }
    | { readonly kind: "emit-failed"; readonly runs: readonly CheckRun[]; readonly failed: readonly CheckRun[] }
    | { readonly kind: "wait"; readonly emptyScans: number }
    | { readonly kind: "pending" }
  > {
    const runs = await this.client.listCheckRuns(ref, pr.headSha);
    if (runs.length > 0) {
      return this.evaluateRuns(runs);
    }
    const suites = await this.client.listCheckSuites(ref, pr.headSha);
    if (suites.length > 0) {
      // Actions has acknowledged the commit (a workflow run was triggered) but
      // no check run exists yet. Wait for the runs to materialise; reset the
      // empty counter because the suite proves the repository does configure
      // tests for this SHA.
      return { kind: "wait", emptyScans: 0 };
    }
    const nextEmpty = state.consecutiveEmptyScansForSha + 1;
    if (nextEmpty >= this.emptyScansBeforeNoTests) {
      return { kind: "emit-succeeded", runs };
    }
    return { kind: "wait", emptyScans: nextEmpty };
  }

  private evaluateRuns(runs: readonly CheckRun[]):
    | { readonly kind: "emit-succeeded"; readonly runs: readonly CheckRun[] }
    | { readonly kind: "emit-failed"; readonly runs: readonly CheckRun[]; readonly failed: readonly CheckRun[] }
    | { readonly kind: "pending" } {
    const allCompleted = runs.every((run) => run.status === "completed");
    if (!allCompleted) {
      return { kind: "pending" };
    }
    const failed = runs.filter(
      (run) => run.conclusion !== null && FAILURE_CONCLUSIONS.has(run.conclusion),
    );
    if (failed.length > 0) {
      return { kind: "emit-failed", runs, failed };
    }
    return { kind: "emit-succeeded", runs };
  }

  private async detectDisappeared(openKeys: Set<string>): Promise<void> {
    const tracked = await this.store.list();
    const disappeared = tracked.filter(
      (entry) => !entry.state.terminal && !openKeys.has(entry.key),
    );
    for (const entry of disappeared) {
      try {
        await this.handleDisappeared(entry.key);
      } catch (cause) {
        this.logger.error("github-producer", "failed while checking disappearance", {
          key: entry.key,
          error: describeCause(cause),
        });
      }
    }
  }

  private async handleDisappeared(key: string): Promise<void> {
    const { ref, repoUrl, number } = parseLifecycleKey(key);
    let pr: PullRequest;
    try {
      pr = await this.client.getPullRequest(ref, number);
    } catch (cause) {
      this.logger.error("github-producer", "failed to fetch disappeared PR", {
        key,
        error: describeCause(cause),
      });
      return;
    }

    let state = await this.store.get(key);
    if (state === null) {
      // record vanished concurrently; nothing to do
      return;
    }

    if (pr.merged && !state.mergedEmitted) {
      await this.emitMerged(pr, ref, repoUrl);
      state = { ...state, mergedEmitted: true };
    }
    state = { ...state, terminal: true };
    await this.store.save(key, state);
  }

  private async emitEvent(producerEventId: string, type: string, payload: unknown): Promise<void> {
    const idGenerator = this.idGenerator;
    const clock = this.clock;
    const sink = this.sink;
    if (idGenerator === null || clock === null || sink === null) {
      throw new UnexpectedStateError("GithubPrProducer has not been started");
    }
    const event = new Event<unknown>(idGenerator.generate(), this.producerId, producerEventId, clock.now(), type, payload);
    await sink.emit(event);
  }

  private prEventId(pr: PullRequest, type: string): string {
    const suffix = type.startsWith("pr.") ? type.slice("pr.".length) : type;
    return `${pr.repoFullName}/PR${pr.number}/${pr.headSha}/${suffix}`;
  }

  private async emitOpened(pr: PullRequest, ref: RepoRef, repoUrl: string): Promise<void> {
    const payload: PrOpenedPayload = {
      ...this.basePayload(pr, ref, repoUrl),
      createdAt: pr.createdAt.toISOString(),
    };
    await this.emitEvent(this.prEventId(pr, PR_OPENED), PR_OPENED, payload);
  }

  private async emitMergeConflicts(pr: PullRequest, ref: RepoRef, repoUrl: string, mergeableState: string): Promise<void> {
    const payload: PrMergeConflictsPayload = {
      ...this.basePayload(pr, ref, repoUrl),
      mergeableState,
    };
    await this.emitEvent(this.prEventId(pr, PR_MERGE_CONFLICTS), PR_MERGE_CONFLICTS, payload);
  }

  private async emitTestsSucceeded(
    pr: PullRequest,
    ref: RepoRef,
    repoUrl: string,
    runs: readonly CheckRun[],
  ): Promise<void> {
    const payload: PrTestsSucceededPayload = {
      ...this.basePayload(pr, ref, repoUrl),
      checkRuns: runs.map(toSummary),
    };
    await this.emitEvent(this.prEventId(pr, PR_TESTS_SUCCEEDED), PR_TESTS_SUCCEEDED, payload);
  }

  private async emitTestsFailed(
    pr: PullRequest,
    ref: RepoRef,
    repoUrl: string,
    runs: readonly CheckRun[],
    failed: readonly CheckRun[],
  ): Promise<void> {
    const payload: PrTestsFailedPayload = {
      ...this.basePayload(pr, ref, repoUrl),
      checkRuns: runs.map(toSummary),
      failedRuns: failed.map(toSummary),
    };
    await this.emitEvent(this.prEventId(pr, PR_TESTS_FAILED), PR_TESTS_FAILED, payload);
  }

  private async emitMerged(pr: PullRequest, ref: RepoRef, repoUrl: string): Promise<void> {
    const clock = this.clock;
    if (clock === null) {
      throw new UnexpectedStateError("GithubPrProducer has not been registered");
    }
    const payload: PrMergedPayload = {
      ...this.basePayload(pr, ref, repoUrl),
      mergedAt: clock.now().toISOString(),
    };
    await this.emitEvent(this.prEventId(pr, PR_MERGED), PR_MERGED, payload);
  }

  private basePayload(pr: PullRequest, ref: RepoRef, repoUrl: string): PrEventPayload {
    return {
      repo: { owner: ref.owner, repo: ref.repo, url: repoUrl },
      number: pr.number,
      title: pr.title,
      url: pr.url,
      author: pr.author,
      draft: pr.draft,
      headSha: pr.headSha,
      headRef: pr.headRef,
    };
  }

  private requireRegistered(): void {
    if (this.idGenerator === null || this.clock === null || this.contexts === null) {
      throw new UnexpectedStateError("GithubPrProducer has not been registered");
    }
  }

  private async resolveMergeableState(pr: PullRequest, ref: RepoRef): Promise<string> {
    try {
      return await fetchAuthoritativeMergeableState(this.client, ref, pr);
    } catch (cause) {
      this.logger.warn("github-producer", "failed to resolve authoritative mergeable_state", {
        key: `${pr.repoFullName}#${pr.number}`,
        headSha: pr.headSha,
        error: describeCause(cause),
      });
      return pr.mergeableState;
    }
  }
}

function toSummary(run: CheckRun): CheckRunSummary {
  return { name: run.name, status: run.status, conclusion: run.conclusion };
}

function parseLifecycleKey(key: string): {
  readonly ref: RepoRef;
  readonly repoUrl: string;
  readonly number: number;
} {
  const hashIndex = key.lastIndexOf("#");
  const repoFullName = hashIndex >= 0 ? key.slice(0, hashIndex) : key;
  const number = hashIndex >= 0 ? Number(key.slice(hashIndex + 1)) : NaN;
  const separator = repoFullName.indexOf("/");
  const owner = separator >= 0 ? repoFullName.slice(0, separator) : repoFullName;
  const repo = separator >= 0 ? repoFullName.slice(separator + 1) : "";
  if (Number.isNaN(number) || owner.length === 0 || repo.length === 0) {
    throw new UnexpectedStateError(`Invalid lifecycle key: ${key}`);
  }
  return {
    ref: { owner, repo },
    repoUrl: `https://github.com/${owner}/${repo}`,
    number,
  };
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.message;
  }
  return String(cause);
}
