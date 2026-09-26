import { describe, it, expect } from "vitest";

import { Event } from "../src/domain/entities/event";
import { Run, type RunState } from "../src/domain/entities/run";
import { Consumer } from "../src/domain/entities/consumer";
import type { Handler } from "../src/domain/ports/out/handler";
import type { Result } from "../src/domain/result";
import { success } from "../src/domain/result";
import type { EventHandlerError } from "../src/domain/exceptions/errors";
import { AbortRunInteractor } from "../src/domain/interactors/abort-run-interactor";
import { SignalEventInteractor } from "../src/domain/interactors/signal-event-interactor";
import { InMemoryEventStore } from "../src/infra/adapters/stores/in-memory-event-store";
import { InMemoryRunRepository } from "../src/infra/adapters/stores/in-memory-run-repository";
import { InMemoryProducerStateRepository } from "../src/infra/adapters/stores/in-memory-producer-state-repository";
import { InMemoryConsumerStateRepository } from "../src/infra/adapters/stores/in-memory-consumer-state-repository";
import { InMemoryPauseStateRepository } from "../src/infra/adapters/stores/in-memory-pause-state-repository";
import { InMemoryConsumerRegistry } from "../src/infra/adapters/registry/in-memory-consumer-registry";
import { InMemoryRunAbortRegistry } from "../src/infra/adapters/registry/in-memory-run-abort-registry";
import { NoOpEventLifecycleObserver } from "../src/infra/adapters/api/no-op-event-lifecycle-observer";
import { InlineProducer } from "../src/infra/adapters/producers/inline/inline-producer";
import {
  FixedClock,
  HangingHandler,
  SequentialIdGenerator,
  TypeRule,
  buildDispatcher,
  successfulOutcome,
} from "./helpers";

const NOW = new Date("2026-07-26T12:00:00Z");

// A source handler that emits a downstream event via an InlineProducer (the
// pattern worker-b, worker-c, worker-a, ... all use to fan out), then
// returns success. This mirrors the real PrVerifyHandler shape: do the work,
// post the result, emit a validation event, return.
class EmittingHandler implements Handler<unknown> {
  public readonly calls: Run<unknown>[] = [];

  public constructor(
    private readonly producer: InlineProducer,
    private readonly downstreamType: string,
  ) {}

  public async handle(run: Run<unknown>, _signal: AbortSignal): Promise<Result<void, EventHandlerError>> {
    this.calls.push(run);
    await this.producer.emit("pevt-downstream", this.downstreamType, { sourceRun: run.id });
    return success(undefined);
  }
}

// A source handler that emits a downstream event via InlineProducer and then
// parks until its AbortSignal fires. Models a long-running agent handler that
// fans out an event mid-run: the bug being fixed left it un-abortable because
// the InlineProducer emit awaited the downstream run, so the source run's
// AbortSignal could never make handle.completion resolve.
class EmittingThenHangingHandler implements Handler<unknown> {
  public readonly calls: Run<unknown>[] = [];

  public constructor(
    private readonly producer: InlineProducer,
    private readonly downstreamType: string,
  ) {}

  public async handle(run: Run<unknown>, signal: AbortSignal): Promise<Result<void, EventHandlerError>> {
    this.calls.push(run);
    await this.producer.emit("pevt-downstream", this.downstreamType, { sourceRun: run.id });
    return new Promise((resolve) => {
      signal.addEventListener("abort", () => resolve(successfulOutcome()), { once: true });
    });
  }
}

interface Fixture {
  readonly sink: SignalEventInteractor;
  readonly runRepository: InMemoryRunRepository;
  readonly consumerRegistry: InMemoryConsumerRegistry;
  readonly producer: InlineProducer;
  readonly abort: AbortRunInteractor;
}

// Builds the dispatcher + sink wiring with an InlineProducer ready to be used
// from inside a handler. The InlineProducer is started against the same sink
// so emits flow through the real SignalEventInteractor + RunDispatcher path.
function buildFixture(): Fixture {
  const eventStore = new InMemoryEventStore();
  const runRepository = new InMemoryRunRepository();
  const consumerRegistry = new InMemoryConsumerRegistry();
  const producerStateRepository = new InMemoryProducerStateRepository();
  const consumerStateRepository = new InMemoryConsumerStateRepository();
  const pauseStateRepository = new InMemoryPauseStateRepository();
  const idGenerator = new SequentialIdGenerator();
  const clock = new FixedClock(NOW);
  const observer = new NoOpEventLifecycleObserver();
  const abortRegistry = new InMemoryRunAbortRegistry();
  const dispatcher = buildDispatcher({
    runRepository,
    idGenerator,
    observer,
    abortRegistry,
    clock,
    consumerRegistry,
    consumerStateRepository,
  });
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
    dispatcher,
  );
  const producer = new InlineProducer("source-inline");
  producer.register({
    idGenerator,
    clock,
    contexts: {} as never,
    addProducer: () => {},
    addConsumer: () => {},
    addEventTemplate: () => {},
  });
  void producer.start(sink);
  const abort = new AbortRunInteractor(runRepository, abortRegistry, observer);
  return { sink, runRepository, consumerRegistry, producer, abort };
}

async function listRunsByState(repository: InMemoryRunRepository, state: RunState): Promise<Run<unknown>[]> {
  const result = await repository.listByState(state, { limit: 50, offset: 0 });
  return result.items;
}

// Async-friendly polling loop (the helpers.ts `waitFor` does not await its
// probe, so it cannot be used with an async probe that reads the run
// repository). Polls every `intervalMs` until `probe` returns a non-undefined
// value, or throws after `timeoutMs`.
async function pollFor<T>(
  probe: () => Promise<T | undefined>,
  timeoutMs = 1_000,
  intervalMs = 10,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("pollFor timed out");
}

// Drives a hanging handler's run to a terminal state by aborting it through
// the same path a real operator would use. Keeps the test process from
// leaking the hanging promise.
async function abortDownstream(fixture: Fixture, downstreamHandler: HangingHandler): Promise<void> {
  const running = await listRunsByState(fixture.runRepository, "RUNNING");
  const downstreamRun = running.find((r) => r.consumerId === "downstream");
  if (downstreamRun === undefined) {
    return;
  }
  try {
    await fixture.abort.abort(downstreamRun.id);
  } catch {
    // The run may already be terminal by the time we abort; that's fine.
  }
  await pollFor(async () => (downstreamHandler.observed.length > 0 ? downstreamHandler.observed[0] : undefined));
}

// Time budget for "must return promptly". Generous enough not to flake under
// CI load, tight enough to distinguish "returns" from "hangs forever" — before
// the fix the abort POST never returned because handle.completion awaited a
// run whose handler was parked inside producer.emit().
const ABORT_DEADLINE_MS = 2_000;

describe("InlineProducer emit does not block the emitting run on downstream consumers", () => {
  it("emitting a downstream event from a handler does not hold the source run in RUNNING until the downstream run finishes", async () => {
    const fixture = buildFixture();
    const { sink, runRepository, consumerRegistry, producer } = fixture;

    // Downstream consumer never resolves on its own (a long agent run, e.g.
    // worker-c). Before the fix, the source run stayed RUNNING for as long
    // as this downstream run was in flight.
    const downstreamHandler = new HangingHandler(successfulOutcome());
    consumerRegistry.register(new Consumer<unknown>("downstream", new TypeRule("downstream"), downstreamHandler, [], []));

    // Source consumer emits the downstream event via InlineProducer and returns.
    const sourceHandler = new EmittingHandler(producer, "downstream");
    consumerRegistry.register(new Consumer<unknown>("source", new TypeRule("source"), sourceHandler, [], []));

    const event = new Event<unknown>("evt-source", "p-1", "pevt-source", NOW, "source", {});
    // This used to block until downstream completed; with the fix it returns
    // once the source handler returns.
    await sink.emit(event);

    // The source run must reach SUCCEEDED even while the downstream run is
    // still in flight — this is the core invariant that was broken.
    const sourceSucceeded = await pollFor(async () => {
      const succeeded = await listRunsByState(runRepository, "SUCCEEDED");
      return succeeded.find((r) => r.consumerId === "source") ?? undefined;
    });
    expect(sourceSucceeded).toBeDefined();
    expect(sourceHandler.calls).toHaveLength(1);

    // The downstream run is still running (never resolved on its own). This
    // proves the source did not wait for it.
    const runningDownstream = await listRunsByState(runRepository, "RUNNING");
    expect(runningDownstream.some((r) => r.consumerId === "downstream")).toBe(true);
    expect(downstreamHandler.calls).toHaveLength(1);

    await abortDownstream(fixture, downstreamHandler);
  });

  it("aborting a source run that has emitted a downstream event returns promptly even while the downstream run is still in flight", async () => {
    const fixture = buildFixture();
    const { sink, runRepository, consumerRegistry, producer, abort } = fixture;

    // Downstream consumer hangs forever on its own.
    const downstreamHandler = new HangingHandler(successfulOutcome());
    consumerRegistry.register(new Consumer<unknown>("downstream", new TypeRule("downstream"), downstreamHandler, [], []));

    // Source consumer emits the downstream event, then parks until its
    // AbortSignal fires (a handler doing more work after the emit).
    const sourceHandler = new EmittingThenHangingHandler(producer, "downstream");
    consumerRegistry.register(new Consumer<unknown>("source", new TypeRule("source"), sourceHandler, [], []));

    const event = new Event<unknown>("evt-source", "p-1", "pevt-source", NOW, "source", {});
    // Kick off the source dispatch; do NOT await — the source handler parks
    // after emitting, so awaiting would block the test.
    void sink.emit(event);

    // Wait for the source run to exist and be RUNNING (handler is parked).
    const sourceRun = await pollFor(async () => {
      const running = await listRunsByState(runRepository, "RUNNING");
      return running.find((r) => r.consumerId === "source") ?? undefined;
    });

    // Wait for the downstream run to also be RUNNING — the scenario where the
    // abort would hang before the fix.
    await pollFor(async () => {
      const running = await listRunsByState(runRepository, "RUNNING");
      return running.some((r) => r.consumerId === "downstream") ? true : undefined;
    });

    // Abort the source run. This must NOT block on the in-flight downstream
    // run. Before the fix this never returned: handle.completion awaited the
    // source run, whose handler was parked inside producer.emit(), which
    // awaited the downstream dispatch.
    const result = await Promise.race([
      abort.abort(sourceRun.id).then(
        (run) => ({ outcome: "resolved" as const, state: run.state }),
        (err: unknown) => ({ outcome: "rejected" as const, err }),
      ),
      new Promise<{ outcome: "hung" }>((resolve) => setTimeout(() => resolve({ outcome: "hung" }), ABORT_DEADLINE_MS)),
    ]);
    expect(result.outcome).not.toBe("hung");

    // The source run must have reached the ABORTED terminal state.
    await pollFor(async () => {
      const aborted = await listRunsByState(runRepository, "ABORTED");
      return aborted.find((r) => r.id === sourceRun.id) ?? undefined;
    });

    await abortDownstream(fixture, downstreamHandler);
  });
});
