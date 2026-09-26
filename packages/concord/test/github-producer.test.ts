import { describe, it, expect, afterEach } from "vitest";

import type { EventSink } from "../src/domain/ports/in/event-sink";
import type { Registration } from "../src/domain/ports/in/registration";
import type { IdGenerator } from "../src/domain/ports/out/id-generator";
import type { Clock } from "../src/domain/ports/out/clock";
import type { ContextResolver, ContextGuard, ContextRequester, ResolvedContext } from "../src/domain/ports/out/context-resolver";
import type { Result } from "../src/domain/result";
import { success, failure } from "../src/domain/result";
import type { ContextResolveError } from "../src/domain/exceptions/errors";
import { ContextResolveError as ContextResolveErrorClass } from "../src/domain/exceptions/errors";
import type { Event } from "../src/domain/entities/event";

import { GithubPrProducer } from "../src/infra/adapters/producers/github/github-producer";
import { noopLogger } from "../src/domain/ports/out/logger";
import type { GitHubClient, RepoRef, ReviewEvent } from "../src/infra/adapters/producers/github/github-client";
import type { GithubIssue } from "../src/infra/adapters/producers/github/github-issue";
import { CheckRun } from "../src/infra/adapters/producers/github/check-run";
import { CheckSuite } from "../src/infra/adapters/producers/github/check-suite";
import {
  PullRequest,
  PR_OPENED,
  PR_MERGE_CONFLICTS,
  PR_TESTS_SUCCEEDED,
  PR_TESTS_FAILED,
  PR_MERGED,
} from "../src/infra/adapters/producers/github/pull-request";
import { InMemoryPullRequestLifecycleStore } from "../src/infra/adapters/producers/github/in-memory-pull-request-lifecycle-store";
import {
  GITHUB_REPOS_CONTEXT,
  type GithubReposContextPayload,
  isGithubReposContextPayload,
} from "../src/infra/adapters/producers/github/github-repos-context";

import { FixedClock, SequentialIdGenerator } from "./helpers";

interface CommentCall {
  readonly ref: RepoRef;
  readonly number: number;
  readonly body: string;
}

class FakeGitHubClient implements GitHubClient {
  public readonly comments: CommentCall[] = [];
  public getPullRequestCalls = 0;
  private readonly prsByRepo: Map<string, PullRequest[]>;
  private readonly checkRunsBySha: Map<string, CheckRun[]>;
  private readonly checkSuitesBySha: Map<string, CheckSuite[]>;
  private readonly prByRefNumber: Map<string, PullRequest>;
  private getPullRequestShouldThrow: unknown = null;

  public constructor(prsByRepo: Map<string, PullRequest[]> = new Map()) {
    this.prsByRepo = prsByRepo;
    this.checkRunsBySha = new Map();
    this.checkSuitesBySha = new Map();
    this.prByRefNumber = new Map();
  }

  public setPullRequests(ref: RepoRef, prs: PullRequest[]): void {
    this.prsByRepo.set(`${ref.owner}/${ref.repo}`, prs);
  }

  public setCheckRuns(sha: string, runs: CheckRun[]): void {
    this.checkRunsBySha.set(sha, runs);
  }

  public setCheckSuites(sha: string, suites: CheckSuite[]): void {
    this.checkSuitesBySha.set(sha, suites);
  }

  public setPullRequest(ref: RepoRef, number: number, pr: PullRequest): void {
    this.prByRefNumber.set(`${ref.owner}/${ref.repo}#${number}`, pr);
  }

  public willThrowOnGetPullRequest(error: unknown): void {
    this.getPullRequestShouldThrow = error;
  }

  public async listOpenPullRequests(ref: RepoRef): Promise<readonly PullRequest[]> {
    const key = `${ref.owner}/${ref.repo}`;
    return [...(this.prsByRepo.get(key) ?? [])];
  }

  public async getPullRequest(ref: RepoRef, number: number): Promise<PullRequest> {
    this.getPullRequestCalls += 1;
    if (this.getPullRequestShouldThrow !== null) {
      throw this.getPullRequestShouldThrow;
    }
    const found = this.prByRefNumber.get(`${ref.owner}/${ref.repo}#${number}`);
    if (found === undefined) {
      throw new Error(`FakeGitHubClient has no PR for ${ref.owner}/${ref.repo}#${number}`);
    }
    return found;
  }

  public async listCheckRuns(_ref: RepoRef, headSha: string): Promise<readonly CheckRun[]> {
    return [...(this.checkRunsBySha.get(headSha) ?? [])];
  }

  public async listCheckSuites(_ref: RepoRef, headSha: string): Promise<readonly CheckSuite[]> {
    return [...(this.checkSuitesBySha.get(headSha) ?? [])];
  }

  public async listOpenIssues(): Promise<readonly GithubIssue[]> {
    return [];
  }

  public async createIssueComment(ref: RepoRef, number: number, body: string): Promise<void> {
    this.comments.push({ ref, number, body });
  }

  public async createReview(_ref: RepoRef, _number: number, _event: ReviewEvent, _body: string): Promise<void> {}

  public async findPullRequestByHead(): Promise<PullRequest | null> {
    return null;
  }

  public async mergePullRequest(): Promise<void> {
    // no-op for producer tests
  }
}

class RecordingSink implements EventSink {
  public readonly events: Event<unknown>[] = [];

  public async emit(event: Event<unknown>): Promise<void> {
    this.events.push(event);
  }

  public async emitDetached(event: Event<unknown>): Promise<void> {
    this.events.push(event);
  }
}

class FixedContextResolver implements ContextResolver {
  public constructor(
    private readonly payload: unknown,
    private readonly secrets: Record<string, string> = {},
  ) {}

  public async resolve<T>(
    requester: ContextRequester,
    name: string,
    guard: ContextGuard<T>,
  ): Promise<Result<ResolvedContext<T>, ContextResolveError>> {
    if (name !== GITHUB_REPOS_CONTEXT) {
      return failure<ResolvedContext<T>, ContextResolveError>(new ContextResolveErrorClass(name, "NOT_FOUND"));
    }
    if (!guard(this.payload)) {
      return failure<ResolvedContext<T>, ContextResolveError>(new ContextResolveErrorClass(name, "INVALID_SHAPE"));
    }
    const resolved: ResolvedContext<T> = { context: this.payload as T, secrets: this.secrets };
    return success(resolved);
  }
}

function buildProducer(client: FakeGitHubClient, payload: unknown): {
  readonly producer: GithubPrProducer;
  readonly sink: RecordingSink;
} {
  const sink = new RecordingSink();
  const resolver = new FixedContextResolver(payload);
  const store = new InMemoryPullRequestLifecycleStore();
  // A small threshold keeps the empty-scans tests fast while still exercising
  // the wait-for-confirmation behaviour. Production uses the producer default.
  const producer = new GithubPrProducer(client, store, 30, noopLogger, 3);

  const registration: Registration = {
    idGenerator: new SequentialIdGenerator() as IdGenerator,
    clock: new FixedClock(new Date("2026-07-04T00:00:00Z")) as Clock,
    contexts: resolver,
    addProducer: () => {},
    addConsumer: () => {},
  };
  producer.register(registration);
  return { producer, sink };
}

const appRef: RepoRef = { owner: "example-corp", repo: "app" };

function pr(
  repoFullName: string,
  number: number,
  title: string,
  headSha = "sha-1",
  mergeableState = "clean",
  headRef = "feature/branch",
): PullRequest {
  return new PullRequest(
    number,
    title,
    `https://github.com/${repoFullName}/pull/${number}`,
    "alice",
    repoFullName,
    false,
    new Date("2026-07-01T00:00:00Z"),
    headSha,
    mergeableState,
    "open",
    false,
    headRef,
  );
}

function run(name: string, status: string, conclusion: string | null): CheckRun {
  return new CheckRun(name, status, conclusion);
}

function suite(status: string, conclusion: string | null): CheckSuite {
  return new CheckSuite(status, conclusion);
}

function singleRepoPayload(repoUrl = "https://github.com/example-corp/app"): GithubReposContextPayload {
  return { repos: [{ name: "app", url: repoUrl }] };
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function typesOf(events: Event<unknown>[]): string[] {
  return events.map((event) => event.type);
}

describe("GithubPrProducer lifecycle", () => {
  let producer: GithubPrProducer | null = null;

  afterEach(async () => {
    if (producer !== null) {
      await producer.stop();
      producer = null;
    }
  });

  it("emits pr.opened exactly once and never re-emits it on later scans", async () => {
    const client = new FakeGitHubClient();
    client.setPullRequests(appRef, [pr("example-corp/app", 101, "Fix leak", "sha-1")]);
    client.setCheckRuns("sha-1", [run("ci", "in_progress", null)]);

    const { producer: p, sink } = buildProducer(client, singleRepoPayload());
    producer = p;
    await p.start(sink);

    expect(typesOf(sink.events)).toEqual([PR_OPENED]);

    await wait(120);
    expect(typesOf(sink.events)).toEqual([PR_OPENED]);
  });

  it("carries the headSha, headRef, and the github-pr producerId on every event", async () => {
    const client = new FakeGitHubClient();
    client.setPullRequests(appRef, [pr("example-corp/app", 7, "T", "deadbeef", "clean", "feature/branch-7")]);
    client.setCheckRuns("deadbeef", [run("ci", "completed", "success")]);

    const { producer: p, sink } = buildProducer(client, singleRepoPayload());
    producer = p;
    await p.start(sink);

    for (const event of sink.events) {
      expect(event.producerId).toBe("github-pr");
      expect((event.payload as { headRef: string }).headRef).toBe("feature/branch-7");
    }
    const opened = sink.events.find((event) => event.type === PR_OPENED);
    expect(opened?.payload).toMatchObject({ headSha: "deadbeef", number: 7, headRef: "feature/branch-7" });
  });

  it("emits pr.merge_conflicts once per dirty SHA and not again on the same SHA", async () => {
    const client = new FakeGitHubClient();
    client.setPullRequests(appRef, [pr("example-corp/app", 1, "C", "sha-1", "dirty")]);
    client.setCheckRuns("sha-1", [run("ci", "in_progress", null)]);

    const { producer: p, sink } = buildProducer(client, singleRepoPayload());
    producer = p;
    await p.start(sink);

    expect(typesOf(sink.events)).toContain(PR_MERGE_CONFLICTS);

    await wait(120);
    const conflictEvents = sink.events.filter((event) => event.type === PR_MERGE_CONFLICTS);
    expect(conflictEvents).toHaveLength(1);
    expect((conflictEvents[0].payload as { mergeableState: string }).mergeableState).toBe("dirty");
  });

  it("emits pr.tests_succeeded when every completed run passes", async () => {
    const client = new FakeGitHubClient();
    client.setPullRequests(appRef, [pr("example-corp/app", 1, "T", "sha-1")]);
    client.setCheckRuns("sha-1", [
      run("build", "completed", "success"),
      run("lint", "completed", "skipped"),
      run("test", "completed", "neutral"),
    ]);

    const { producer: p, sink } = buildProducer(client, singleRepoPayload());
    producer = p;
    await p.start(sink);

    const event = sink.events.find((event) => event.type === PR_TESTS_SUCCEEDED);
    expect(event).toBeDefined();
    const payload = event!.payload as { checkRuns: { name: string; conclusion: string | null }[] };
    expect(payload.checkRuns.map((entry) => entry.name).sort()).toEqual(["build", "lint", "test"]);
  });

  it("emits pr.tests_failed when at least one run fails, with only the failing summaries", async () => {
    const client = new FakeGitHubClient();
    client.setPullRequests(appRef, [pr("example-corp/app", 1, "T", "sha-1")]);
    client.setCheckRuns("sha-1", [
      run("build", "completed", "success"),
      run("test", "completed", "failure"),
      run("e2e", "completed", "timed_out"),
    ]);

    const { producer: p, sink } = buildProducer(client, singleRepoPayload());
    producer = p;
    await p.start(sink);

    const event = sink.events.find((event) => event.type === PR_TESTS_FAILED);
    expect(event).toBeDefined();
    const payload = event!.payload as {
      checkRuns: { name: string }[];
      failedRuns: { name: string }[];
    };
    expect(payload.checkRuns.map((entry) => entry.name).sort()).toEqual(["build", "e2e", "test"]);
    expect(payload.failedRuns.map((entry) => entry.name).sort()).toEqual(["e2e", "test"]);
  });

  it("emits pr.tests_succeeded when zero runs AND zero suites persist past the empty-scan threshold", async () => {
    const client = new FakeGitHubClient();
    client.setPullRequests(appRef, [pr("example-corp/app", 1, "T", "sha-1")]);
    client.setCheckRuns("sha-1", []);
    client.setCheckSuites("sha-1", []);

    const { producer: p, sink } = buildProducer(client, singleRepoPayload());
    producer = p;
    await p.start(sink);

    // First scan must NOT misfire: an empty first poll is ambiguous and the
    // producer waits for confirmation rather than declaring success.
    expect(typesOf(sink.events)).not.toContain(PR_TESTS_SUCCEEDED);

    // After the threshold of consecutive empty scans, the producer concludes
    // the repository has no Actions configured and emits success.
    await wait(150);
    expect(typesOf(sink.events)).toContain(PR_TESTS_SUCCEEDED);
    const event = sink.events.find((event) => event.type === PR_TESTS_SUCCEEDED);
    expect((event!.payload as { checkRuns: unknown[] }).checkRuns).toEqual([]);
  });

  it("waits without emitting when check suites exist but no check run has been created yet", async () => {
    const client = new FakeGitHubClient();
    client.setPullRequests(appRef, [pr("example-corp/app", 1, "T", "sha-1")]);
    client.setCheckRuns("sha-1", []);
    // A suite exists: GitHub Actions has acknowledged the push and a workflow
    // run has started, but no check run has been reported yet. This is the
    // exact window that used to misfire `pr.tests_succeeded`.
    client.setCheckSuites("sha-1", [suite("in_progress", null)]);

    const { producer: p, sink } = buildProducer(client, singleRepoPayload());
    producer = p;
    await p.start(sink);

    expect(typesOf(sink.events)).not.toContain(PR_TESTS_SUCCEEDED);
    expect(typesOf(sink.events)).not.toContain(PR_TESTS_FAILED);

    await wait(150);
    expect(typesOf(sink.events)).not.toContain(PR_TESTS_SUCCEEDED);
    expect(typesOf(sink.events)).not.toContain(PR_TESTS_FAILED);
  });

  it("does not misfire pr.tests_succeeded when the first empty poll races a push and tests then fail", async () => {
    // Reproduces the production bug: the producer's first poll lands in the
    // sub-second window between a push and GitHub Actions creating the first
    // check suite. The suite and a failing check run appear afterwards, and
    // the producer must converge on pr.tests_failed rather than the premature
    // pr.tests_succeeded the original implementation emitted.
    const client = new FakeGitHubClient();
    client.setPullRequests(appRef, [pr("example-corp/app", 928, "T", "sha-1")]);
    client.setCheckRuns("sha-1", []);
    client.setCheckSuites("sha-1", []);

    const { producer: p, sink } = buildProducer(client, singleRepoPayload());
    producer = p;
    await p.start(sink);

    // First scan: empty. No emit, no terminal transition.
    expect(typesOf(sink.events)).toEqual([PR_OPENED]);

    // The race window closes: GitHub Actions registers the suite and the runs.
    client.setCheckSuites("sha-1", [suite("completed", "failure")]);
    client.setCheckRuns("sha-1", [
      run("build", "completed", "success"),
      run("integration", "completed", "failure"),
    ]);

    await wait(150);

    expect(typesOf(sink.events)).not.toContain(PR_TESTS_SUCCEEDED);
    const failed = sink.events.filter((event) => event.type === PR_TESTS_FAILED);
    expect(failed).toHaveLength(1);
    const payload = failed[0].payload as { failedRuns: { name: string }[] };
    expect(payload.failedRuns.map((entry) => entry.name)).toEqual(["integration"]);
  });

  it("emits nothing for tests while runs are still queued or in progress", async () => {
    const client = new FakeGitHubClient();
    client.setPullRequests(appRef, [pr("example-corp/app", 1, "T", "sha-1")]);
    client.setCheckRuns("sha-1", [run("ci", "queued", null), run("build", "in_progress", null)]);

    const { producer: p, sink } = buildProducer(client, singleRepoPayload());
    producer = p;
    await p.start(sink);

    expect(typesOf(sink.events)).toEqual([PR_OPENED]);

    await wait(120);
    expect(typesOf(sink.events)).toEqual([PR_OPENED]);
  });

  it("re-emits pr.tests_succeeded for a new head SHA after a push", async () => {
    const client = new FakeGitHubClient();
    const sha1 = pr("example-corp/app", 1, "T", "sha-1");
    client.setPullRequests(appRef, [sha1]);
    client.setCheckRuns("sha-1", [run("ci", "completed", "success")]);

    const { producer: p, sink } = buildProducer(client, singleRepoPayload());
    producer = p;
    await p.start(sink);

    const firstTests = sink.events.filter((event) => event.type === PR_TESTS_SUCCEEDED);
    expect(firstTests).toHaveLength(1);
    expect((firstTests[0].payload as { headSha: string }).headSha).toBe("sha-1");

    const sha2 = pr("example-corp/app", 1, "T", "sha-2");
    client.setPullRequests(appRef, [sha2]);
    client.setCheckRuns("sha-2", [run("ci", "completed", "success")]);

    await wait(120);

    const testsEvents = sink.events.filter((event) => event.type === PR_TESTS_SUCCEEDED);
    expect(testsEvents).toHaveLength(2);
    expect((testsEvents[1].payload as { headSha: string }).headSha).toBe("sha-2");

    const openedEvents = sink.events.filter((event) => event.type === PR_OPENED);
    expect(openedEvents).toHaveLength(1);
  });

  it("emits pr.merged once when a tracked PR disappears and is reported merged", async () => {
    const client = new FakeGitHubClient();
    client.setPullRequests(appRef, [pr("example-corp/app", 5, "M", "sha-1")]);
    client.setCheckRuns("sha-1", [run("ci", "in_progress", null)]);

    const { producer: p, sink } = buildProducer(client, singleRepoPayload());
    producer = p;
    await p.start(sink);

    client.setPullRequests(appRef, []);
    client.setPullRequest(appRef, 5, new PullRequest(
      5, "M", "https://github.com/example-corp/app/pull/5",
      "alice", "example-corp/app", false, new Date("2026-07-01T00:00:00Z"),
      "sha-1", "clean", "closed", true, "feature/branch",
    ));

    await wait(120);

    const mergedEvents = sink.events.filter((event) => event.type === PR_MERGED);
    expect(mergedEvents).toHaveLength(1);
    expect(mergedEvents[0].payload).toMatchObject({ number: 5, headSha: "sha-1" });

    await wait(120);
    const mergedAgain = sink.events.filter((event) => event.type === PR_MERGED);
    expect(mergedAgain).toHaveLength(1);
  });

  it("marks a PR terminal without pr.merged when it disappears closed but not merged", async () => {
    const client = new FakeGitHubClient();
    client.setPullRequests(appRef, [pr("example-corp/app", 6, "C", "sha-1")]);
    client.setCheckRuns("sha-1", [run("ci", "in_progress", null)]);

    const { producer: p, sink } = buildProducer(client, singleRepoPayload());
    producer = p;
    await p.start(sink);

    client.setPullRequests(appRef, []);
    client.setPullRequest(appRef, 6, new PullRequest(
      6, "C", "https://github.com/example-corp/app/pull/6",
      "alice", "example-corp/app", false, new Date("2026-07-01T00:00:00Z"),
      "sha-1", "clean", "closed", false, "feature/branch",
    ));

    await wait(120);

    expect(typesOf(sink.events)).not.toContain(PR_MERGED);
    expect(typesOf(sink.events)).not.toContain(PR_TESTS_SUCCEEDED);
    expect(typesOf(sink.events)).not.toContain(PR_TESTS_FAILED);
  });

  it("can fire pr.merge_conflicts and pr.tests_failed in the same scan", async () => {
    const client = new FakeGitHubClient();
    client.setPullRequests(appRef, [pr("example-corp/app", 1, "T", "sha-1", "dirty")]);
    client.setCheckRuns("sha-1", [run("ci", "completed", "failure")]);

    const { producer: p, sink } = buildProducer(client, singleRepoPayload());
    producer = p;
    await p.start(sink);

    expect(typesOf(sink.events)).toContain(PR_OPENED);
    expect(typesOf(sink.events)).toContain(PR_MERGE_CONFLICTS);
    expect(typesOf(sink.events)).toContain(PR_TESTS_FAILED);
  });

  it("resolves pr.merge_conflicts via getPullRequest when pulls.list reports unknown", async () => {
    // Reproduces the production bug: a genuinely conflicted PR whose
    // pulls.list mergeable_state is the placeholder "unknown". Without the
    // authoritative resolution the producer never emits pr.merge_conflicts,
    // so merge-conflict-fix never runs. The producer must fall back to
    // pulls.get and carry the resolved value into the event payload.
    const client = new FakeGitHubClient();
    client.setPullRequests(appRef, [pr("example-corp/app", 1, "T", "sha-1", "unknown")]);
    client.setCheckRuns("sha-1", [run("ci", "in_progress", null)]);
    client.setPullRequest(appRef, 1, pr("example-corp/app", 1, "T", "sha-1", "dirty"));

    const { producer: p, sink } = buildProducer(client, singleRepoPayload());
    producer = p;
    await p.start(sink);

    expect(typesOf(sink.events)).toContain(PR_MERGE_CONFLICTS);
    expect(client.getPullRequestCalls).toBe(1);
    const conflictEvent = sink.events.find((event) => event.type === PR_MERGE_CONFLICTS);
    expect((conflictEvent!.payload as { mergeableState: string }).mergeableState).toBe("dirty");
  });

  it("does not call getPullRequest when pulls.list already reports a definitive state", async () => {
    const client = new FakeGitHubClient();
    client.setPullRequests(appRef, [pr("example-corp/app", 1, "T", "sha-1", "dirty")]);
    client.setCheckRuns("sha-1", [run("ci", "in_progress", null)]);

    const { producer: p, sink } = buildProducer(client, singleRepoPayload());
    producer = p;
    await p.start(sink);

    expect(typesOf(sink.events)).toContain(PR_MERGE_CONFLICTS);
    expect(client.getPullRequestCalls).toBe(0);
  });

  it("does not emit pr.merge_conflicts when the authoritative value is still unknown", async () => {
    // pulls.get has not finished computing either; the producer must not guess
    // dirty and must retry on a later scan instead.
    const client = new FakeGitHubClient();
    client.setPullRequests(appRef, [pr("example-corp/app", 1, "T", "sha-1", "unknown")]);
    client.setCheckRuns("sha-1", [run("ci", "in_progress", null)]);
    client.setPullRequest(appRef, 1, pr("example-corp/app", 1, "T", "sha-1", "unknown"));

    const { producer: p, sink } = buildProducer(client, singleRepoPayload());
    producer = p;
    await p.start(sink);

    expect(typesOf(sink.events)).not.toContain(PR_MERGE_CONFLICTS);
    expect(client.getPullRequestCalls).toBe(1);
  });

  it("skips merge_conflict emission and keeps scanning when the authoritative fetch fails", async () => {
    // A transient pulls.get failure must not crash the scan; the producer logs
    // and retries on the next scan. Tests are still evaluated this scan.
    const client = new FakeGitHubClient();
    client.setPullRequests(appRef, [pr("example-corp/app", 1, "T", "sha-1", "unknown")]);
    client.setCheckRuns("sha-1", [run("ci", "completed", "success")]);
    client.willThrowOnGetPullRequest(new Error("transient 5xx"));

    const { producer: p, sink } = buildProducer(client, singleRepoPayload());
    producer = p;
    await p.start(sink);

    expect(typesOf(sink.events)).not.toContain(PR_MERGE_CONFLICTS);
    // The scan continued past the failed resolution and evaluated tests.
    expect(typesOf(sink.events)).toContain(PR_TESTS_SUCCEEDED);
    expect(client.getPullRequestCalls).toBe(1);
  });

  it("skips repos with an invalid URL without stopping the rest of the scan", async () => {
    const payload: GithubReposContextPayload = {
      repos: [
        { name: "broken", url: "not-a-url" },
        { name: "app", url: "https://github.com/example-corp/app" },
      ],
    };
    const client = new FakeGitHubClient();
    client.setPullRequests(appRef, [pr("example-corp/app", 9, "Nine", "sha-9")]);
    client.setCheckRuns("sha-9", []);

    const { producer: p, sink } = buildProducer(client, payload);
    producer = p;
    await p.start(sink);

    const opened = sink.events.find((event) => event.type === PR_OPENED);
    expect(opened?.payload).toMatchObject({ number: 9 });
  });

  it("emits nothing and keeps polling when the context cannot be resolved", async () => {
    const client = new FakeGitHubClient();
    client.setPullRequests(appRef, [pr("example-corp/app", 1, "One")]);
    const sink = new RecordingSink();
    const store = new InMemoryPullRequestLifecycleStore();
    const producerInstance = new GithubPrProducer(client, store, 30, noopLogger);
    const resolver: ContextResolver = {
      async resolve<T>(
        _requester: ContextRequester,
        name: string,
        _guard: ContextGuard<T>,
      ): Promise<Result<ResolvedContext<T>, ContextResolveError>> {
        return failure<ResolvedContext<T>, ContextResolveError>(new ContextResolveErrorClass(name, "NOT_FOUND"));
      },
    };
    producerInstance.register({
      idGenerator: new SequentialIdGenerator(),
      clock: new FixedClock(new Date("2026-07-04T00:00:00Z")),
      contexts: resolver,
      addProducer: () => {},
      addConsumer: () => {},
    });
    producer = producerInstance;

    await producerInstance.start(sink);

    expect(sink.events).toHaveLength(0);
    await wait(80);
    expect(sink.events).toHaveLength(0);
  });
});

describe("isGithubReposContextPayload guard", () => {
  const reposPayload: GithubReposContextPayload = {
    repos: [{ name: "app", url: "https://github.com/example-corp/app" }],
  };

  it("accepts the documented shape", () => {
    expect(isGithubReposContextPayload(reposPayload)).toBe(true);
  });

  it("rejects payloads missing the repos array", () => {
    expect(isGithubReposContextPayload({})).toBe(false);
    expect(isGithubReposContextPayload({ repos: "nope" })).toBe(false);
  });

  it("rejects repo entries without string name/url", () => {
    expect(isGithubReposContextPayload({ repos: [{ name: 1, url: "x" }] })).toBe(false);
    expect(isGithubReposContextPayload({ repos: [{ name: "ok" }] })).toBe(false);
  });
});
