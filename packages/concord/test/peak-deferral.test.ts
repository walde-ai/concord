import { describe, it, expect } from "vitest";
import { Event } from "../src/domain/entities/event";
import { Consumer } from "../src/domain/entities/consumer";
import { Run } from "../src/domain/entities/run";
import {
  RunNotAbortableError,
  RunNotFoundError,
} from "../src/domain/exceptions/errors";
import { RunDispatcher } from "../src/domain/interactors/run-dispatcher";
import { NoOpRunCompletionHook } from "../src/domain/ports/out/run-completion-hook";
import { noopLogger } from "../src/domain/ports/out/logger";
import { noopLogContextScope } from "../src/domain/ports/out/log-context";
import { AbortRunInteractor } from "../src/domain/interactors/abort-run-interactor";
import { RestartRunInteractor } from "../src/domain/interactors/restart-run-interactor";
import { InMemoryRunRepository } from "../src/infra/adapters/stores/in-memory-run-repository";
import { InMemoryPeakHoursRepository } from "../src/infra/adapters/stores/in-memory-peak-hours-repository";
import { InMemoryConsumerStateRepository } from "../src/infra/adapters/stores/in-memory-consumer-state-repository";
import { InMemoryConsumerConfigRepository } from "../src/infra/adapters/stores/in-memory-consumer-config-repository";
import { InMemoryConsumerRegistry } from "../src/infra/adapters/registry/in-memory-consumer-registry";
import { InMemoryRunAbortRegistry } from "../src/infra/adapters/registry/in-memory-run-abort-registry";
import { InMemoryRunTimeoutClock } from "../src/infra/adapters/registry/in-memory-run-timeout-clock";
import { NoOpEventLifecycleObserver } from "../src/infra/adapters/api/no-op-event-lifecycle-observer";
import { MergingConsumerConfigResolver } from "../src/infra/adapters/config/merging-consumer-config-resolver";
import {
  SequentialIdGenerator,
  FixedClock,
  RecordingHandler,
  TypeRule,
  FakePeakSchedule,
  successfulOutcome,
  FixedRunTimeoutResolver,
} from "./helpers";
import { DEFAULT_RUN_TIMEOUT_MS } from "../src/domain/ports/out/run-timeout-resolver";
import { AGENT_CONSUMER_CONFIG_SCHEMA } from "../src/infra/adapters/consumers/agents/agent-config-schema";
import { AgentTaskRunner } from "../src/infra/adapters/consumers/agents/agent-task-runner";
import { RepoEntryLookup } from "../src/infra/adapters/consumers/agents/repo-entry-lookup";
import {
  FakeOpencodeRunner,
  FakeWorktreeManager,
  RecordingGitHubClient,
  RecordingConsumerGitHubClientResolver,
  repoEntry,
} from "./fakes";
import type { ContextResolver, ContextRequester, ContextGuard, ResolvedContext } from "../src/domain/ports/out/context-resolver";
import type { Result } from "../src/domain/result";
import { success } from "../src/domain/result";
import type { ContextResolveError } from "../src/domain/exceptions/errors";

const NOW = new Date("2026-07-05T12:00:00Z");

function buildFixture(opts: { readonly peak: boolean; readonly peakHours?: { start: string; end: string; timezone: string } | null }): {
  readonly dispatcher: RunDispatcher;
  readonly runRepository: InMemoryRunRepository;
  readonly consumerStateRepository: InMemoryConsumerStateRepository;
  readonly consumerRegistry: InMemoryConsumerRegistry;
  readonly abortRegistry: InMemoryRunAbortRegistry;
  readonly peakHoursRepository: InMemoryPeakHoursRepository;
} {
  const runRepository = new InMemoryRunRepository();
  const peakHoursRepository = new InMemoryPeakHoursRepository();
  void peakHoursRepository.set(opts.peakHours ?? null);
  const consumerStateRepository = new InMemoryConsumerStateRepository();
  const consumerRegistry = new InMemoryConsumerRegistry();
  const abortRegistry = new InMemoryRunAbortRegistry();
  const dispatcher = new RunDispatcher(
    runRepository,
    new SequentialIdGenerator(),
    new NoOpEventLifecycleObserver(),
    abortRegistry,
    new FixedClock(NOW),
    peakHoursRepository,
    new FakePeakSchedule(opts.peak),
    consumerStateRepository,
    consumerRegistry,
    new FixedRunTimeoutResolver(DEFAULT_RUN_TIMEOUT_MS),
    new InMemoryRunTimeoutClock(),
    noopLogger,
    noopLogContextScope,
    new NoOpRunCompletionHook(),
  );
  return { dispatcher, runRepository, consumerStateRepository, consumerRegistry, abortRegistry, peakHoursRepository };
}

function event(): Event<unknown> {
  return new Event<unknown>("evt-1", "p-1", "pevt-1", NOW, "foo", {});
}

describe("RunDispatcher deferral", () => {
  it("parks a run in WAIT_FOR_OFFPEAK when the flag is set and the schedule reports peak", async () => {
    const fixture = buildFixture({ peak: true, peakHours: { start: "09:00", end: "17:00", timezone: "UTC" } });
    const handler = new RecordingHandler(successfulOutcome());
    fixture.consumerRegistry.register(new Consumer<unknown>("c-1", new TypeRule("foo"), handler, [], []));
    await fixture.consumerStateRepository.setWaitForOffPeak("c-1", true);

    const consumer = fixture.consumerRegistry.all()[0];
    const run = await fixture.dispatcher.dispatch(event(), consumer);

    expect(run.state).toBe("WAIT_FOR_OFFPEAK");
    expect(handler.calls).toHaveLength(0);
  });

  it("dispatches normally when off-peak even with the flag set", async () => {
    const fixture = buildFixture({ peak: false, peakHours: { start: "09:00", end: "17:00", timezone: "UTC" } });
    const handler = new RecordingHandler(successfulOutcome());
    fixture.consumerRegistry.register(new Consumer<unknown>("c-1", new TypeRule("foo"), handler, [], []));
    await fixture.consumerStateRepository.setWaitForOffPeak("c-1", true);

    const consumer = fixture.consumerRegistry.all()[0];
    const run = await fixture.dispatcher.dispatch(event(), consumer);

    expect(run.state).toBe("SUCCEEDED");
    expect(handler.calls).toHaveLength(1);
  });

  it("has no effect when peak hours are null even if the flag is set", async () => {
    const fixture = buildFixture({ peak: true, peakHours: null });
    const handler = new RecordingHandler(successfulOutcome());
    fixture.consumerRegistry.register(new Consumer<unknown>("c-1", new TypeRule("foo"), handler, [], []));
    await fixture.consumerStateRepository.setWaitForOffPeak("c-1", true);

    const consumer = fixture.consumerRegistry.all()[0];
    const run = await fixture.dispatcher.dispatch(event(), consumer);

    expect(run.state).toBe("SUCCEEDED");
  });

  it("resume executes a parked run when the consumer is enabled", async () => {
    const fixture = buildFixture({ peak: true, peakHours: { start: "09:00", end: "17:00", timezone: "UTC" } });
    const handler = new RecordingHandler(successfulOutcome());
    fixture.consumerRegistry.register(new Consumer<unknown>("c-1", new TypeRule("foo"), handler, [], []));
    await fixture.consumerStateRepository.setWaitForOffPeak("c-1", true);

    const consumer = fixture.consumerRegistry.all()[0];
    const parked = await fixture.dispatcher.dispatch(event(), consumer);
    expect(parked.state).toBe("WAIT_FOR_OFFPEAK");

    const resumed = await fixture.dispatcher.resume(parked.id);
    expect(resumed?.state).toBe("SUCCEEDED");
    expect(handler.calls).toHaveLength(1);
  });

  it("resume marks the run FAILED when the consumer is no longer registered", async () => {
    const fixture = buildFixture({ peak: true, peakHours: { start: "09:00", end: "17:00", timezone: "UTC" } });
    const handler = new RecordingHandler(successfulOutcome());
    fixture.consumerRegistry.register(new Consumer<unknown>("c-1", new TypeRule("foo"), handler, [], []));
    await fixture.consumerStateRepository.setWaitForOffPeak("c-1", true);

    const consumer = fixture.consumerRegistry.all()[0];
    const parked = await fixture.dispatcher.dispatch(event(), consumer);

    (fixture.consumerRegistry as unknown as { consumers: Consumer<unknown>[] }).consumers = [];
    const resumed = await fixture.dispatcher.resume(parked.id);
    expect(resumed?.state).toBe("FAILED");
  });

  it("resume leaves the run parked when the consumer is disabled", async () => {
    const fixture = buildFixture({ peak: true, peakHours: { start: "09:00", end: "17:00", timezone: "UTC" } });
    const handler = new RecordingHandler(successfulOutcome());
    fixture.consumerRegistry.register(new Consumer<unknown>("c-1", new TypeRule("foo"), handler, [], []));
    await fixture.consumerStateRepository.setWaitForOffPeak("c-1", true);

    const consumer = fixture.consumerRegistry.all()[0];
    const parked = await fixture.dispatcher.dispatch(event(), consumer);
    await fixture.consumerStateRepository.setEnabled("c-1", false);

    const resumed = await fixture.dispatcher.resume(parked.id);
    expect(resumed?.state).toBe("WAIT_FOR_OFFPEAK");
    expect(handler.calls).toHaveLength(0);
  });
});

describe("AbortRunInteractor with WAIT_FOR_OFFPEAK", () => {
  it("aborts a parked run directly without invoking the handler", async () => {
    const fixture = buildFixture({ peak: true, peakHours: { start: "09:00", end: "17:00", timezone: "UTC" } });
    const handler = new RecordingHandler(successfulOutcome());
    fixture.consumerRegistry.register(new Consumer<unknown>("c-1", new TypeRule("foo"), handler, [], []));
    await fixture.consumerStateRepository.setWaitForOffPeak("c-1", true);
    const observer = new NoOpEventLifecycleObserver();
    const abort = new AbortRunInteractor(fixture.runRepository, fixture.abortRegistry, observer);

    const consumer = fixture.consumerRegistry.all()[0];
    const parked = await fixture.dispatcher.dispatch(event(), consumer);
    const aborted = await abort.abort(parked.id);

    expect(aborted.state).toBe("ABORTED");
    expect(handler.calls).toHaveLength(0);
  });

  it("throws RunNotFoundError when aborting an unknown id", async () => {
    const fixture = buildFixture({ peak: false, peakHours: { start: "09:00", end: "17:00", timezone: "UTC" } });
    const abort = new AbortRunInteractor(fixture.runRepository, fixture.abortRegistry, new NoOpEventLifecycleObserver());
    await expect(abort.abort("nope")).rejects.toBeInstanceOf(RunNotFoundError);
  });

  it("throws RunNotAbortableError when aborting a terminal run", async () => {
    const fixture = buildFixture({ peak: false, peakHours: { start: "09:00", end: "17:00", timezone: "UTC" } });
    const handler = new RecordingHandler(successfulOutcome());
    fixture.consumerRegistry.register(new Consumer<unknown>("c-1", new TypeRule("foo"), handler, [], []));
    const abort = new AbortRunInteractor(fixture.runRepository, fixture.abortRegistry, new NoOpEventLifecycleObserver());

    const consumer = fixture.consumerRegistry.all()[0];
    const finished = await fixture.dispatcher.dispatch(event(), consumer);
    await expect(abort.abort(finished.id)).rejects.toBeInstanceOf(RunNotAbortableError);
  });
});

describe("RestartRunInteractor with WAIT_FOR_OFFPEAK", () => {
  it("restarts a parked run during off-peak into a fresh executing run", async () => {
    const fixture = buildFixture({ peak: true, peakHours: { start: "09:00", end: "17:00", timezone: "UTC" } });
    const handler = new RecordingHandler(successfulOutcome());
    fixture.consumerRegistry.register(new Consumer<unknown>("c-1", new TypeRule("foo"), handler, [], []));
    await fixture.consumerStateRepository.setWaitForOffPeak("c-1", true);
    const restart = new RestartRunInteractor(fixture.runRepository, fixture.consumerRegistry, fixture.consumerStateRepository, fixture.dispatcher);

    const consumer = fixture.consumerRegistry.all()[0];
    const parked = await fixture.dispatcher.dispatch(event(), consumer);

    // Flip to off-peak so the restart dispatches immediately.
    (fixture.dispatcher as unknown as { peakSchedule: { isPeakAt: () => boolean } }).peakSchedule = new FakePeakSchedule(false);
    const restarted = await restart.restart(parked.id);

    expect(restarted.state).toBe("RUNNING");
    expect(restarted.id).not.toBe(parked.id);
    await fixture.dispatcher.awaitDetached();
    expect(restarted.state).toBe("SUCCEEDED");
    expect(handler.calls).toHaveLength(1);
  });

  it("restarts a parked run during peak into another parked run", async () => {
    const fixture = buildFixture({ peak: true, peakHours: { start: "09:00", end: "17:00", timezone: "UTC" } });
    const handler = new RecordingHandler(successfulOutcome());
    fixture.consumerRegistry.register(new Consumer<unknown>("c-1", new TypeRule("foo"), handler, [], []));
    await fixture.consumerStateRepository.setWaitForOffPeak("c-1", true);
    const restart = new RestartRunInteractor(fixture.runRepository, fixture.consumerRegistry, fixture.consumerStateRepository, fixture.dispatcher);

    const consumer = fixture.consumerRegistry.all()[0];
    const parked = await fixture.dispatcher.dispatch(event(), consumer);
    const restarted = await restart.restart(parked.id);

    expect(restarted.state).toBe("WAIT_FOR_OFFPEAK");
    expect(restarted.id).not.toBe(parked.id);
  });
});

class FixedContextResolver implements ContextResolver {
  public constructor(private readonly payload: unknown) {}
  public async resolve<T>(
    _requester: ContextRequester,
    _name: string,
    guard: ContextGuard<T>,
  ): Promise<Result<ResolvedContext<T>, ContextResolveError>> {
    return success({ context: this.payload as T, secrets: {} as never }) as Result<ResolvedContext<T>, ContextResolveError>;
    void guard;
  }
}

describe("AgentTaskRunner config wiring", () => {
  it("resolves the consumer's modelId and agentName and forwards them as runner options", async () => {
    const registry = new InMemoryConsumerRegistry();
    registry.register(new Consumer<unknown>("consumer-a", new TypeRule("foo"), new RecordingHandler(successfulOutcome()), AGENT_CONSUMER_CONFIG_SCHEMA, []));
    const configRepo = new InMemoryConsumerConfigRepository();
    await configRepo.set("consumer-a", { modelId: "anthropic/claude-sonnet-4.5", agentName: "build" });
    const resolver = new MergingConsumerConfigResolver(registry, configRepo);

    const runner = new FakeOpencodeRunner();
    const client = new RecordingGitHubClient();
    const taskRunner = new AgentTaskRunner(
      new RepoEntryLookup(new FixedContextResolver({ repos: [repoEntry()] })),
      new FakeWorktreeManager(),
      runner,
      new RecordingConsumerGitHubClientResolver(client),
      resolver,
    );

    const result = await taskRunner.runCodeProducingTask({
      consumerId: "consumer-a",
      runId: "run-1",
      repo: { owner: "example", repo: "example" },
      branch: { kind: "existing", branch: "feature/x" },
      prompt: "fix",
      source: "test",
    });

    expect(result.ok).toBe(true);
    expect(runner.runCalls).toHaveLength(1);
    expect(runner.runCalls[0].options).toEqual({
      agentId: "build",
      modelId: "anthropic/claude-sonnet-4.5",
      runId: "run-1",
      consumerId: "consumer-a",
      maxInputRounds: 0,
    });
  });

  it("resolves empty agent/model when nothing is persisted (agent+model are required, not defaulted)", async () => {
    const registry = new InMemoryConsumerRegistry();
    registry.register(new Consumer<unknown>("consumer-a", new TypeRule("foo"), new RecordingHandler(successfulOutcome()), AGENT_CONSUMER_CONFIG_SCHEMA, []));
    const resolver = new MergingConsumerConfigResolver(registry, new InMemoryConsumerConfigRepository());

    const runner = new FakeOpencodeRunner();
    const taskRunner = new AgentTaskRunner(
      new RepoEntryLookup(new FixedContextResolver({ repos: [repoEntry()] })),
      new FakeWorktreeManager(),
      runner,
      new RecordingConsumerGitHubClientResolver(new RecordingGitHubClient()),
      resolver,
    );

    await taskRunner.runCodeProducingTask({
      consumerId: "consumer-a",
      runId: "run-1",
      repo: { owner: "example", repo: "example" },
      branch: { kind: "existing", branch: "feature/x" },
      prompt: "fix",
      source: "test",
    });

    // No fallback to a magic agent id: an unconfigured consumer resolves to
    // empty agent/model, which OpencodeSdkRunner rejects with a clear error
    // (the guard) rather than sending an invalid id to opencode.
    expect(runner.runCalls[0].options).toEqual({
      agentId: "",
      modelId: "",
      runId: "run-1",
      consumerId: "consumer-a",
      maxInputRounds: 0,
    });
  });
});
