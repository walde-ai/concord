import { describe, it, expect } from "vitest";

import { Event } from "../src/domain/entities/event";
import { EventNotFoundError, EventNotReplayableError } from "../src/domain/exceptions/errors";
import { ReplayEventInteractor } from "../src/domain/interactors/replay-event-interactor";
import { SignalEventInteractor } from "../src/domain/interactors/signal-event-interactor";
import { RunDispatcher } from "../src/domain/interactors/run-dispatcher";
import { InMemoryEventStore } from "../src/infra/adapters/stores/in-memory-event-store";
import { InMemoryRunRepository } from "../src/infra/adapters/stores/in-memory-run-repository";
import { InMemoryProducerStateRepository } from "../src/infra/adapters/stores/in-memory-producer-state-repository";
import { InMemoryConsumerStateRepository } from "../src/infra/adapters/stores/in-memory-consumer-state-repository";
import { InMemoryPauseStateRepository } from "../src/infra/adapters/stores/in-memory-pause-state-repository";
import { InMemoryConsumerRegistry } from "../src/infra/adapters/registry/in-memory-consumer-registry";
import { InMemoryRunAbortRegistry } from "../src/infra/adapters/registry/in-memory-run-abort-registry";
import { NoOpEventLifecycleObserver } from "../src/infra/adapters/api/no-op-event-lifecycle-observer";
import { REPLAY_PRODUCER_ID } from "../src/infra/adapters/replay/replay-producer-id";
import { Consumer } from "../src/domain/entities/consumer";
import {
  FixedClock,
  RecordingHandler,
  SequentialIdGenerator,
  TypeRule,
  buildDispatcher,
  successfulOutcome,
} from "./helpers";

const NOW = new Date("2026-07-05T12:00:00Z");

function buildSink(eventStore: InMemoryEventStore, pauseStateRepository: InMemoryPauseStateRepository) {
  const runRepository = new InMemoryRunRepository();
  const consumerRegistry = new InMemoryConsumerRegistry();
  const producerStateRepository = new InMemoryProducerStateRepository();
  const consumerStateRepository = new InMemoryConsumerStateRepository();
  const idGenerator = new SequentialIdGenerator();
  const clock = new FixedClock(NOW);
  const observer = new NoOpEventLifecycleObserver();
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
  return { sink, consumerRegistry };
}

function buildReplay(eventStore: InMemoryEventStore, pauseStateRepository: InMemoryPauseStateRepository) {
  const idGenerator = new SequentialIdGenerator();
  const clock = new FixedClock(NOW);
  const { sink } = buildSink(eventStore, pauseStateRepository);
  return new ReplayEventInteractor(eventStore, sink, idGenerator, clock);
}

describe("ReplayEventInteractor", () => {
  it("creates a new event with producerId concord.replay, the same type and payload, and a suffixed producerEventId", async () => {
    const eventStore = new InMemoryEventStore();
    const source = new Event<unknown>("evt-1", "p-1", "pevt-1", NOW, "foo", { n: 1 });
    await eventStore.save(source);

    const replay = buildReplay(eventStore, new InMemoryPauseStateRepository());
    const replayed = await replay.replay("evt-1");

    expect(replayed.id).not.toBe(source.id);
    expect(replayed.producerId).toBe(REPLAY_PRODUCER_ID);
    expect(replayed.type).toBe("foo");
    expect(replayed.payload).toEqual({ n: 1 });
    expect(replayed.producerEventId).toBe(`pevt-1#${NOW.getTime()}`);
    expect(replayed.datetime.toISOString()).toBe(NOW.toISOString());
  });

  it("produces two distinct events when replaying the same event twice", async () => {
    const eventStore = new InMemoryEventStore();
    const source = new Event<unknown>("evt-1", "p-1", "pevt-1", NOW, "foo", {});
    await eventStore.save(source);

    let tick = 1_000;
    const idGenerator = new SequentialIdGenerator();
    const clock = { now: () => new Date(tick++) };
    const { sink } = buildSink(eventStore, new InMemoryPauseStateRepository());
    const replay = new ReplayEventInteractor(eventStore, sink, idGenerator, clock as unknown as { now(): Date });

    const first = await replay.replay("evt-1");
    const second = await replay.replay("evt-1");

    expect(first.producerEventId).not.toBe(second.producerEventId);
    expect(first.id).not.toBe(second.id);
  });

  it("dispatches a replayed event normally even when the original was muted", async () => {
    const eventStore = new InMemoryEventStore();
    const producerStateRepository = new InMemoryProducerStateRepository();
    await producerStateRepository.setEnabled("p-1", false);
    const source = new Event<unknown>("evt-1", "p-1", "pevt-1", NOW, "foo", { n: 1 });
    source.markMuted();
    await eventStore.save(source);

    const pauseStateRepository = new InMemoryPauseStateRepository();
    const runRepository = new InMemoryRunRepository();
    const consumerRegistry = new InMemoryConsumerRegistry();
    const consumerStateRepository = new InMemoryConsumerStateRepository();
    const idGenerator = new SequentialIdGenerator();
    const clock = new FixedClock(NOW);
    const observer = new NoOpEventLifecycleObserver();
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

    const handler = new RecordingHandler(successfulOutcome());
    consumerRegistry.register(new Consumer<unknown>("c-1", new TypeRule("foo"), handler, [], []));

    const replay = new ReplayEventInteractor(eventStore, sink, idGenerator, clock);
    const replayed = await replay.replay("evt-1");

    expect(replayed.producerId).toBe(REPLAY_PRODUCER_ID);
    expect(replayed.muted).toBe(false);
    expect(handler.calls).toHaveLength(1);
    expect(handler.calls[0].event.id).toBe(replayed.id);
  });

  it("refuses to replay an event whose producerId is concord.replay", async () => {
    const eventStore = new InMemoryEventStore();
    const replayed = new Event<unknown>("evt-r", REPLAY_PRODUCER_ID, "pevt#1", NOW, "foo", {});
    await eventStore.save(replayed);

    const replay = buildReplay(eventStore, new InMemoryPauseStateRepository());

    await expect(replay.replay("evt-r")).rejects.toBeInstanceOf(EventNotReplayableError);
  });

  it("surfaces EventNotFoundError when the source event id is unknown", async () => {
    const replay = buildReplay(new InMemoryEventStore(), new InMemoryPauseStateRepository());
    await expect(replay.replay("missing")).rejects.toBeInstanceOf(EventNotFoundError);
  });

  it("persists the replayed event as muted when the system is paused", async () => {
    const eventStore = new InMemoryEventStore();
    const source = new Event<unknown>("evt-1", "p-1", "pevt-1", NOW, "foo", {});
    await eventStore.save(source);

    const pauseStateRepository = new InMemoryPauseStateRepository();
    await pauseStateRepository.setPaused(true);

    const replay = buildReplay(eventStore, pauseStateRepository);
    const replayed = await replay.replay("evt-1");

    expect(replayed.muted).toBe(true);
    const stored = await eventStore.getById(replayed.id);
    expect(stored.muted).toBe(true);
  });

  it("succeeds even when a prior run for the source event is still RUNNING", async () => {
    const eventStore = new InMemoryEventStore();
    const source = new Event<unknown>("evt-1", "p-1", "pevt-1", NOW, "foo", {});
    await eventStore.save(source);

    const replay = buildReplay(eventStore, new InMemoryPauseStateRepository());
    const result = await replay.replay("evt-1");
    expect(result.producerId).toBe(REPLAY_PRODUCER_ID);
  });
});
