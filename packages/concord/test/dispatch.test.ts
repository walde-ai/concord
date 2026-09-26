import { describe, it, expect, vi } from "vitest";
import { MakeApp } from "../src/infra/main/make-app";
import { InMemoryEventStore } from "../src/infra/adapters/stores/in-memory-event-store";
import { InMemoryRunRepository } from "../src/infra/adapters/stores/in-memory-run-repository";
import { InMemoryProducerStateRepository } from "../src/infra/adapters/stores/in-memory-producer-state-repository";
import { InMemoryConsumerStateRepository } from "../src/infra/adapters/stores/in-memory-consumer-state-repository";
import { InMemoryPauseStateRepository } from "../src/infra/adapters/stores/in-memory-pause-state-repository";
import { InMemoryConsumerRegistry } from "../src/infra/adapters/registry/in-memory-consumer-registry";
import { InMemoryProducerRegistry } from "../src/infra/adapters/registry/in-memory-producer-registry";
import { InMemoryRunAbortRegistry } from "../src/infra/adapters/registry/in-memory-run-abort-registry";
import { NoOpEventLifecycleObserver } from "../src/infra/adapters/api/no-op-event-lifecycle-observer";
import { SignalEventInteractor } from "../src/domain/interactors/signal-event-interactor";
import { RunDispatcher } from "../src/domain/interactors/run-dispatcher";
import { ListProducersInteractor } from "../src/domain/interactors/list-producers-interactor";
import { ListConsumersInteractor } from "../src/domain/interactors/list-consumers-interactor";
import { ConsumerDescriptorBuilder } from "../src/domain/interactors/consumer-descriptor-builder";
import { InMemoryConsumerConfigRepository } from "../src/infra/adapters/stores/in-memory-consumer-config-repository";
import { MergingConsumerConfigResolver } from "../src/infra/adapters/config/merging-consumer-config-resolver";
import { RepositoryConsumerSecretResolver } from "../src/infra/adapters/config/repository-consumer-secret-resolver";
import { ConsumerRegistrable } from "../src/infra/adapters/consumers/consumer-registrable";
import { Consumer } from "../src/domain/entities/consumer";
import { Event } from "../src/domain/entities/event";
import { failure } from "../src/domain/result";
import { EventHandlerError, RunSupersededError, UnexpectedHandlerError } from "../src/domain/exceptions/errors";
import { ModelStreamStalledError } from "../src/infra/adapters/opencode/session-stall-watchdog";
import {
  FakeProducer,
  FixedClock,
  RecordingHandler,
  SequentialIdGenerator,
  ThrowingHandler,
  TypeRule,
  buildDispatcher,
  successfulOutcome,
} from "./helpers";

describe("in-memory dispatch", () => {
  it("delivers an event only to matching consumers and persists terminal run states", async () => {
    const eventStore = new InMemoryEventStore();
    const runRepository = new InMemoryRunRepository();
    const idGenerator = new SequentialIdGenerator();
    const clock = new FixedClock(new Date("2026-07-02T00:00:00Z"));

    const app = MakeApp({ eventStore, runRepository, idGenerator, clock });

    const successHandler = new RecordingHandler(successfulOutcome());
    const failureHandler = new RecordingHandler(
      failure<void, EventHandlerError>(new EventHandlerError("boom")),
    );
    const unrelatedHandler = new RecordingHandler(successfulOutcome());

    app.register(new ConsumerRegistrable(new Consumer<unknown>("c-success", new TypeRule("foo"), successHandler, [], [])));
    app.register(new ConsumerRegistrable(new Consumer<unknown>("c-fail", new TypeRule("foo"), failureHandler, [], [])));
    app.register(new ConsumerRegistrable(new Consumer<unknown>("c-other", new TypeRule("bar"), unrelatedHandler, [], [])));

    const event = new Event<unknown>("evt-1", "p-1", "pevt-1", clock.now(), "foo", { n: 1 });
    app.register(new FakeProducer("p-1", [event]));

    await app.start();

    expect(successHandler.calls).toHaveLength(1);
    expect(failureHandler.calls).toHaveLength(1);
    expect(unrelatedHandler.calls).toHaveLength(0);

    const successRun = await runRepository.getById(successHandler.calls[0].id);
    expect(successRun.state).toBe("SUCCEEDED");
    expect(successRun.failure).toBeNull();

    const failureRun = await runRepository.getById(failureHandler.calls[0].id);
    expect(failureRun.state).toBe("FAILED");
    expect(failureRun.failure).not.toBeNull();
    expect(failureRun.failure?.errorName).toBe("EventHandlerError");
    expect(failureRun.failure?.message).toBe("boom");
    expect(failureRun.failure?.stack).not.toBeNull();

    expect(eventStore.all().map((stored) => stored.id)).toEqual(["evt-1"]);

    await app.stop();
  });

  it("isolates handler failures so a throwing consumer cannot stop its siblings", async () => {
    const runRepository = new InMemoryRunRepository();
    const clock = new FixedClock(new Date("2026-07-02T00:00:00Z"));

    const app = MakeApp({
      runRepository,
      idGenerator: new SequentialIdGenerator(),
      clock,
    });

    const throwingHandler = new ThrowingHandler(new Error("handler exploded"));
    const siblingHandler = new RecordingHandler(successfulOutcome());

    app.register(new ConsumerRegistrable(new Consumer<unknown>("c-throw", new TypeRule("foo"), throwingHandler, [], [])));
    app.register(new ConsumerRegistrable(new Consumer<unknown>("c-sibling", new TypeRule("foo"), siblingHandler, [], [])));

    app.register(new FakeProducer("p-1", [new Event<unknown>("evt-1", "p-1", "pevt-1", clock.now(), "foo", {})]));

    await app.start();

    expect(throwingHandler.calls).toHaveLength(1);
    expect(siblingHandler.calls).toHaveLength(1);

    const thrownRun = await runRepository.getById(throwingHandler.calls[0].id);
    expect(thrownRun.state).toBe("FAILED");
    expect(thrownRun.failure).not.toBeNull();
    expect(thrownRun.failure?.errorName).toBe("UnexpectedHandlerError");
    expect(thrownRun.failure?.message).toContain("handler exploded");

    const siblingRun = await runRepository.getById(siblingHandler.calls[0].id);
    expect(siblingRun.state).toBe("SUCCEEDED");

    await app.stop();
  });

  it("rejects lookups of unknown runs rather than returning null", async () => {
    const runRepository = new InMemoryRunRepository();
    await expect(runRepository.getById("does-not-exist")).rejects.toBeInstanceOf(Error);
  });

  it("transitions a run to SUPERSEDED when the handler returns RunSupersededError", async () => {
    const runRepository = new InMemoryRunRepository();
    const clock = new FixedClock(new Date("2026-07-02T00:00:00Z"));

    const app = MakeApp({ runRepository, idGenerator: new SequentialIdGenerator(), clock });

    const supersededHandler = new RecordingHandler(
      failure<void, EventHandlerError>(new RunSupersededError("PR no longer open")),
    );
    app.register(new ConsumerRegistrable(new Consumer<unknown>("c-superseded", new TypeRule("foo"), supersededHandler, [], [])));
    app.register(new FakeProducer("p-1", [new Event<unknown>("evt-1", "p-1", "pevt-1", clock.now(), "foo", {})]));

    await app.start();

    expect(supersededHandler.calls).toHaveLength(1);
    const supersededRun = await runRepository.getById(supersededHandler.calls[0].id);
    expect(supersededRun.state).toBe("SUPERSEDED");
    // SUPERSEDED is intentionally not a failure: the failure payload must be
    // null so the UI does not render a red error block.
    expect(supersededRun.failure).toBeNull();
    expect(supersededRun.finishedAt).not.toBeNull();

    await app.stop();
  });
});

describe("dispatch under enable/disable toggles", () => {
  it("stores an event as muted and dispatches nothing when its producer is disabled", async () => {
    const eventStore = new InMemoryEventStore();
    const runRepository = new InMemoryRunRepository();
    const consumerRegistry = new InMemoryConsumerRegistry();
    const producerStateRepository = new InMemoryProducerStateRepository();
    const consumerStateRepository = new InMemoryConsumerStateRepository();
    const idGenerator = new SequentialIdGenerator();
    const clock = new FixedClock(new Date("2026-07-04T00:00:00Z"));
    const observer = new NoOpEventLifecycleObserver();

    const handler = new RecordingHandler(successfulOutcome());
    consumerRegistry.register(new Consumer<unknown>("c-1", new TypeRule("foo"), handler, [], []));

    await producerStateRepository.setEnabled("p-1", false);

    const sink = new SignalEventInteractor(
      eventStore,
      runRepository,
      consumerRegistry,
      producerStateRepository,
      consumerStateRepository,
      idGenerator,
      clock,
      observer,
      new InMemoryPauseStateRepository(),
      buildDispatcher({ runRepository, idGenerator, observer, clock }),
    );

    const event = new Event<unknown>("evt-1", "p-1", "pevt-1", clock.now(), "foo", { n: 1 });
    await sink.emit(event);

    expect(handler.calls).toHaveLength(0);
    expect(eventStore.all()).toHaveLength(1);
    expect(eventStore.all()[0].muted).toBe(true);
  });

  it("skips a disabled consumer while dispatching to an enabled sibling", async () => {
    const eventStore = new InMemoryEventStore();
    const runRepository = new InMemoryRunRepository();
    const consumerRegistry = new InMemoryConsumerRegistry();
    const producerStateRepository = new InMemoryProducerStateRepository();
    const consumerStateRepository = new InMemoryConsumerStateRepository();
    const idGenerator = new SequentialIdGenerator();
    const clock = new FixedClock(new Date("2026-07-04T00:00:00Z"));
    const observer = new NoOpEventLifecycleObserver();

    const enabledHandler = new RecordingHandler(successfulOutcome());
    const disabledHandler = new RecordingHandler(successfulOutcome());
    consumerRegistry.register(new Consumer<unknown>("c-on", new TypeRule("foo"), enabledHandler, [], []));
    consumerRegistry.register(new Consumer<unknown>("c-off", new TypeRule("foo"), disabledHandler, [], []));

    await consumerStateRepository.setEnabled("c-off", false);

    const sink = new SignalEventInteractor(
      eventStore,
      runRepository,
      consumerRegistry,
      producerStateRepository,
      consumerStateRepository,
      idGenerator,
      clock,
      observer,
      new InMemoryPauseStateRepository(),
      buildDispatcher({ runRepository, idGenerator, observer, clock }),
    );

    const event = new Event<unknown>("evt-1", "p-1", "pevt-1", clock.now(), "foo", { n: 1 });
    await sink.emit(event);

    expect(enabledHandler.calls).toHaveLength(1);
    expect(disabledHandler.calls).toHaveLength(0);
    expect(eventStore.all()[0].muted).toBe(false);
  });

  it("reports freshly registered producers and consumers as enabled by default", async () => {
    const producerRegistry = new InMemoryProducerRegistry();
    const consumerRegistry = new InMemoryConsumerRegistry();
    const producerStateRepository = new InMemoryProducerStateRepository();
    const consumerStateRepository = new InMemoryConsumerStateRepository();

    producerRegistry.register({ producerId: "p-1", disableable: true });
    consumerRegistry.register(new Consumer<unknown>("c-1", new TypeRule("foo"), new RecordingHandler(successfulOutcome()), [], []));

    const listProducers = new ListProducersInteractor(producerRegistry, producerStateRepository);
    const configRepository = new InMemoryConsumerConfigRepository();
    const descriptorBuilder = new ConsumerDescriptorBuilder(
      consumerRegistry,
      consumerStateRepository,
      new MergingConsumerConfigResolver(consumerRegistry, configRepository),
      new RepositoryConsumerSecretResolver(consumerRegistry, configRepository),
    );
    const listConsumers = new ListConsumersInteractor(consumerRegistry, descriptorBuilder);

    const producers = await listProducers.list();
    expect(producers).toEqual([{ producerId: "p-1", enabled: true, disableable: true }]);

    const consumers = await listConsumers.list();
    expect(consumers).toEqual([{ consumerId: "c-1", enabled: true, waitForOffPeak: false, configParameters: [], configValues: {}, secretParameters: [], secretNames: [] }]);
  });
});

describe("event idempotency", () => {
  it("silently drops a re-emitted event that shares (producerId, producerEventId) with one already stored", async () => {
    const eventStore = new InMemoryEventStore();
    const runRepository = new InMemoryRunRepository();
    const consumerRegistry = new InMemoryConsumerRegistry();
    const producerStateRepository = new InMemoryProducerStateRepository();
    const consumerStateRepository = new InMemoryConsumerStateRepository();
    const idGenerator = new SequentialIdGenerator();
    const clock = new FixedClock(new Date("2026-07-04T00:00:00Z"));
    const observer = new NoOpEventLifecycleObserver();

    const handler = new RecordingHandler(successfulOutcome());
    consumerRegistry.register(new Consumer<unknown>("c-1", new TypeRule("foo"), handler, [], []));

    const sink = new SignalEventInteractor(
      eventStore,
      runRepository,
      consumerRegistry,
      producerStateRepository,
      consumerStateRepository,
      idGenerator,
      clock,
      observer,
      new InMemoryPauseStateRepository(),
      buildDispatcher({ runRepository, idGenerator, observer, clock }),
    );

    const first = new Event<unknown>("evt-1", "p-1", "pevt-1", clock.now(), "foo", { n: 1 });
    const duplicate = new Event<unknown>("evt-other", "p-1", "pevt-1", clock.now(), "foo", { n: 2 });

    await sink.emit(first);
    await sink.emit(duplicate);

    expect(eventStore.all()).toHaveLength(1);
    expect(eventStore.all()[0].id).toBe("evt-1");
    expect(handler.calls).toHaveLength(1);

    const runs = await runRepository.list({ limit: 10, offset: 0 });
    expect(runs.total).toBe(1);
  });

  it("keeps both events when the producerEventId differs even for the same producer", async () => {
    const eventStore = new InMemoryEventStore();
    const runRepository = new InMemoryRunRepository();
    const consumerRegistry = new InMemoryConsumerRegistry();
    const producerStateRepository = new InMemoryProducerStateRepository();
    const consumerStateRepository = new InMemoryConsumerStateRepository();
    const idGenerator = new SequentialIdGenerator();
    const clock = new FixedClock(new Date("2026-07-04T00:00:00Z"));
    const observer = new NoOpEventLifecycleObserver();

    const handler = new RecordingHandler(successfulOutcome());
    consumerRegistry.register(new Consumer<unknown>("c-1", new TypeRule("foo"), handler, [], []));

    const sink = new SignalEventInteractor(
      eventStore,
      runRepository,
      consumerRegistry,
      producerStateRepository,
      consumerStateRepository,
      idGenerator,
      clock,
      observer,
      new InMemoryPauseStateRepository(),
      buildDispatcher({ runRepository, idGenerator, observer, clock }),
    );

    await sink.emit(new Event<unknown>("evt-1", "p-1", "pevt-1", clock.now(), "foo", {}));
    await sink.emit(new Event<unknown>("evt-2", "p-1", "pevt-2", clock.now(), "foo", {}));

    expect(eventStore.all()).toHaveLength(2);
    expect(handler.calls).toHaveLength(2);
  });
});

describe("global pause behaviour", () => {
  function buildSink(overrides: {
    readonly pauseStateRepository?: InMemoryPauseStateRepository;
    readonly producerStateRepository?: InMemoryProducerStateRepository;
  } = {}) {
    const eventStore = new InMemoryEventStore();
    const runRepository = new InMemoryRunRepository();
    const consumerRegistry = new InMemoryConsumerRegistry();
    const producerStateRepository = overrides.producerStateRepository ?? new InMemoryProducerStateRepository();
    const consumerStateRepository = new InMemoryConsumerStateRepository();
    const pauseStateRepository = overrides.pauseStateRepository ?? new InMemoryPauseStateRepository();
    const idGenerator = new SequentialIdGenerator();
    const clock = new FixedClock(new Date("2026-07-04T00:00:00Z"));
    const observer = new NoOpEventLifecycleObserver();
    const handler = new RecordingHandler(successfulOutcome());
    consumerRegistry.register(new Consumer<unknown>("c-1", new TypeRule("foo"), handler, [], []));
    const sink = new SignalEventInteractor(
      eventStore,
      runRepository,
      consumerRegistry,
      producerStateRepository,
      consumerStateRepository,
      idGenerator,
      clock,
      observer,
      pauseStateRepository,
      buildDispatcher({ runRepository, idGenerator, observer, clock }),
    );
    return { sink, eventStore, runRepository, handler, producerStateRepository, pauseStateRepository, clock };
  }

  it("mutes events emitted while the system is paused and dispatches nothing", async () => {
    const { sink, eventStore, handler, pauseStateRepository, clock } = buildSink();
    await pauseStateRepository.setPaused(true);

    await sink.emit(new Event<unknown>("evt-1", "p-1", "pevt-1", clock.now(), "foo", { n: 1 }));

    expect(eventStore.all()).toHaveLength(1);
    expect(eventStore.all()[0].muted).toBe(true);
    expect(handler.calls).toHaveLength(0);
  });

  it("resumes dispatching once the system is un-paused", async () => {
    const { sink, eventStore, handler, pauseStateRepository, clock } = buildSink();
    await pauseStateRepository.setPaused(true);
    await sink.emit(new Event<unknown>("evt-1", "p-1", "pevt-1", clock.now(), "foo", {}));
    await pauseStateRepository.setPaused(false);
    await sink.emit(new Event<unknown>("evt-2", "p-1", "pevt-2", clock.now(), "foo", {}));

    expect(eventStore.all().map((event) => event.id)).toEqual(["evt-1", "evt-2"]);
    expect(eventStore.all()[0].muted).toBe(true);
    expect(eventStore.all()[1].muted).toBe(false);
    expect(handler.calls).toHaveLength(1);
    expect(handler.calls[0].event.id).toBe("evt-2");
  });

  it("mutes an event once when both pause and producer-disable apply", async () => {
    const producerStateRepository = new InMemoryProducerStateRepository();
    await producerStateRepository.setEnabled("p-1", false);
    const { sink, eventStore, handler, pauseStateRepository, clock } = buildSink({ producerStateRepository });
    await pauseStateRepository.setPaused(true);

    await sink.emit(new Event<unknown>("evt-1", "p-1", "pevt-1", clock.now(), "foo", {}));

    expect(eventStore.all()).toHaveLength(1);
    expect(eventStore.all()[0].muted).toBe(true);
    expect(handler.calls).toHaveLength(0);
  });

  it("preserves a producer's disabled state across pause and un-pause", async () => {
    const producerStateRepository = new InMemoryProducerStateRepository();
    await producerStateRepository.setEnabled("p-1", false);
    const { sink, eventStore, handler, pauseStateRepository, clock } = buildSink({ producerStateRepository });

    await pauseStateRepository.setPaused(true);
    await sink.emit(new Event<unknown>("evt-1", "p-1", "pevt-1", clock.now(), "foo", {}));
    await pauseStateRepository.setPaused(false);
    await sink.emit(new Event<unknown>("evt-2", "p-1", "pevt-2", clock.now(), "foo", {}));

    expect(eventStore.all()).toHaveLength(2);
    expect(eventStore.all()[0].muted).toBe(true);
    expect(eventStore.all()[1].muted).toBe(true);
    expect(handler.calls).toHaveLength(0);
  });
});

describe("run completion hook", () => {
  it("notifies the hook for every terminal run, carrying the terminal state", async () => {
    const runRepository = new InMemoryRunRepository();
    const idGenerator = new SequentialIdGenerator();
    const clock = new FixedClock(new Date("2026-07-04T00:00:00Z"));
    const finished: string[] = [];
    const dispatcher = buildDispatcher({
      runRepository,
      idGenerator,
      clock,
      completionHook: {
        runFinished: async (completion: { runId: string; state: string }) => {
          finished.push(`${completion.runId}:${completion.state}`);
        },
      },
    });

    const okConsumer = new Consumer<unknown>("c-ok", new TypeRule("foo"), new RecordingHandler(successfulOutcome()), [], []);
    const failConsumer = new Consumer<unknown>(
      "c-fail",
      new TypeRule("foo"),
      new RecordingHandler(failure<void, EventHandlerError>(new EventHandlerError("boom"))),
      [],
      [],
    );
    const event = new Event<unknown>("evt-1", "p-1", "pevt-1", clock.now(), "foo", {});

    const okRun = await dispatcher.dispatch(event, okConsumer);
    const failRun = await dispatcher.dispatch(event, failConsumer);

    expect(okRun.state).toBe("SUCCEEDED");
    expect(failRun.state).toBe("FAILED");
    await vi.waitFor(() => {
      expect([...finished].sort()).toEqual([`${okRun.id}:SUCCEEDED`, `${failRun.id}:FAILED`].sort());
    });
  });

  it("never lets a throwing hook fail the run's own completion", async () => {
    const runRepository = new InMemoryRunRepository();
    const idGenerator = new SequentialIdGenerator();
    const clock = new FixedClock(new Date("2026-07-04T00:00:00Z"));
    const dispatcher = buildDispatcher({
      runRepository,
      idGenerator,
      clock,
      completionHook: {
        runFinished: async () => {
          throw new Error("cleanup exploded");
        },
      },
    });

    const consumer = new Consumer<unknown>("c-1", new TypeRule("foo"), new RecordingHandler(successfulOutcome()), [], []);
    const event = new Event<unknown>("evt-1", "p-1", "pevt-1", clock.now(), "foo", {});
    const run = await dispatcher.dispatch(event, consumer);

    expect(run.state).toBe("SUCCEEDED");
  });
});

describe("model-stall failure handling", () => {
  function stallFailure(): ReturnType<typeof failure> {
    // The infra layer's error, wrapped the way runHandler wraps a thrown cause.
    return failure<void, EventHandlerError>(
      new UnexpectedHandlerError(new ModelStreamStalledError(240_000, 240_001, 60_001)),
    );
  }

  it("records the sentinel error name and re-dispatches the event, capped at MAX_STALL_REDISPATCH extra runs", async () => {
    const eventStore = new InMemoryEventStore();
    const runRepository = new InMemoryRunRepository();
    const idGenerator = new SequentialIdGenerator();
    const clock = new FixedClock(new Date("2026-09-04T19:37:21Z"));

    const app = MakeApp({ eventStore, runRepository, idGenerator, clock });

    // Every attempt fails with the same model stall, as a hard outage would.
    const handler = new RecordingHandler(stallFailure());
    app.register(new ConsumerRegistrable(new Consumer<unknown>("c-stall", new TypeRule("foo"), handler, [], [])));

    const event = new Event<unknown>("evt-stall", "p-1", "pevt-stall", clock.now(), "foo", { n: 1 });
    app.register(new FakeProducer("p-1", [event]));

    await app.start();
    await app.awaitRuns(); // drains the detached re-dispatch chain
    await app.stop();

    // 1 original run + 2 re-dispatches (cap), then the failure is terminal.
    expect(handler.calls).toHaveLength(3);
    const runs = await runRepository.listByEventId(event.id, { limit: 100, offset: 0 });
    expect(runs.items).toHaveLength(3);
    for (const run of runs.items) {
      expect(run.state).toBe("FAILED");
      expect(run.failure?.errorName).toBe("ModelStreamStalledError");
      expect(run.failure?.message).toMatch(/opencode model stream appeared stalled/);
    }
  });

  it("recognizes a stall whose signature was flattened into an EventHandlerError message", async () => {
    const eventStore = new InMemoryEventStore();
    const runRepository = new InMemoryRunRepository();
    const idGenerator = new SequentialIdGenerator();
    const clock = new FixedClock(new Date("2026-09-04T19:37:21Z"));

    const app = MakeApp({ eventStore, runRepository, idGenerator, clock });

    // worker-style wrapping: the cause chain is flattened into a message.
    const flattened = new EventHandlerError(
      `Unexpected error thrown by handler: opencode model stream appeared stalled: cumulative model-idle 240001ms exceeded the 240000ms budget`,
    );
    const handler = new RecordingHandler(failure<void, EventHandlerError>(flattened));
    app.register(new ConsumerRegistrable(new Consumer<unknown>("c-flat", new TypeRule("foo"), handler, [], [])));

    const event = new Event<unknown>("evt-flat", "p-1", "pevt-flat", clock.now(), "foo", { n: 1 });
    app.register(new FakeProducer("p-1", [event]));

    await app.start();
    await app.awaitRuns();
    await app.stop();

    expect(handler.calls).toHaveLength(3);
    const runs = await runRepository.listByEventId(event.id, { limit: 100, offset: 0 });
    expect(runs.items).toHaveLength(3);
    for (const run of runs.items) {
      expect(run.failure?.errorName).toBe("ModelStreamStalledError");
    }
  });
});
