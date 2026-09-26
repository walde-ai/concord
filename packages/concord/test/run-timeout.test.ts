import { describe, it, expect } from "vitest";

import { Event } from "../src/domain/entities/event";
import { Consumer } from "../src/domain/entities/consumer";
import type { RunTimeoutResolver } from "../src/domain/ports/out/run-timeout-resolver";
import { DEFAULT_RUN_TIMEOUT_MS } from "../src/domain/ports/out/run-timeout-resolver";
import { AbortRunInteractor } from "../src/domain/interactors/abort-run-interactor";
import { InMemoryRunRepository } from "../src/infra/adapters/stores/in-memory-run-repository";
import { InMemoryRunAbortRegistry } from "../src/infra/adapters/registry/in-memory-run-abort-registry";
import { NoOpEventLifecycleObserver } from "../src/infra/adapters/api/no-op-event-lifecycle-observer";
import {
  HangingHandler,
  RecordingHandler,
  SequentialIdGenerator,
  TypeRule,
  buildDispatcher,
  successfulOutcome,
  waitFor,
  type Clock,
} from "./helpers";

const NOW = new Date("2026-07-09T12:00:00Z");

class FixedClock implements Clock {
  public now(): Date {
    return NOW;
  }
}

class CapturingTimeoutResolver implements RunTimeoutResolver {
  public readonly resolveCalls: string[] = [];

  public constructor(private readonly timeoutMs: number) {}

  public async resolve(consumerId: string): Promise<number> {
    this.resolveCalls.push(consumerId);
    return this.timeoutMs;
  }
}

function buildDispatcherFixture(timeoutMs: number): {
  readonly dispatcher: ReturnType<typeof buildDispatcher>;
  readonly abort: AbortRunInteractor;
  readonly runRepository: InMemoryRunRepository;
  readonly timeoutResolver: CapturingTimeoutResolver;
} {
  const runRepository = new InMemoryRunRepository();
  const abortRegistry = new InMemoryRunAbortRegistry();
  const observer = new NoOpEventLifecycleObserver();
  const idGenerator = new SequentialIdGenerator();
  const clock = new FixedClock();
  const timeoutResolver = new CapturingTimeoutResolver(timeoutMs);
  const dispatcher = buildDispatcher({ runRepository, idGenerator, observer, abortRegistry, clock, timeoutResolver });
  const abort = new AbortRunInteractor(runRepository, abortRegistry, observer);
  return { dispatcher, abort, runRepository, timeoutResolver };
}

describe("RunDispatcher run timeout", () => {
  it("times out a hanging run after the configured timeout and records a RunTimeoutError failure", async () => {
    const timeoutMs = 50;
    const { dispatcher, runRepository } = buildDispatcherFixture(timeoutMs);
    const handler = new HangingHandler();
    const consumer = new Consumer<unknown>("c-1", new TypeRule("foo"), handler, [], []);
    const event = new Event<unknown>("evt-1", "p-1", "pevt-1", NOW, "foo", {});

    const finished = await dispatcher.dispatch(event, consumer);

    expect(finished.state).toBe("TIMED_OUT");
    expect(finished.failure).not.toBeNull();
    expect(finished.failure?.errorName).toBe("RunTimeoutError");
    expect(finished.failure?.message).toContain(`${timeoutMs}ms`);

    const persisted = await runRepository.getById(finished.id);
    expect(persisted.state).toBe("TIMED_OUT");
    expect(persisted.failure?.errorName).toBe("RunTimeoutError");

    await waitFor(() => (handler.observed.length > 0 ? handler.observed : undefined));
    expect(handler.observed[0].aborted).toBe(true);
  });

  it("does not abort a run that succeeds before the timeout elapses", async () => {
    const { dispatcher, runRepository } = buildDispatcherFixture(10_000);
    const handler = new RecordingHandler(successfulOutcome());
    const consumer = new Consumer<unknown>("c-1", new TypeRule("foo"), handler, [], []);
    const event = new Event<unknown>("evt-1", "p-1", "pevt-1", NOW, "foo", {});

    const finished = await dispatcher.dispatch(event, consumer);

    expect(finished.state).toBe("SUCCEEDED");
    expect(finished.failure).toBeNull();
    const persisted = await runRepository.getById(finished.id);
    expect(persisted.state).toBe("SUCCEEDED");
  });

  it("records no failure for a manually aborted run even while a timeout is armed", async () => {
    const { dispatcher, abort } = buildDispatcherFixture(100_000);
    const handler = new HangingHandler();
    const consumer = new Consumer<unknown>("c-1", new TypeRule("foo"), handler, [], []);
    const event = new Event<unknown>("evt-1", "p-1", "pevt-1", NOW, "foo", {});

    const dispatchPromise = dispatcher.dispatch(event, consumer);
    await waitFor(() => (handler.calls.length > 0 ? handler.calls : undefined));

    const aborted = await abort.abort(handler.calls[0].id);
    await dispatchPromise;

    expect(aborted.state).toBe("ABORTED");
    expect(aborted.failure).toBeNull();
  });

  it("resolves the timeout per consumer so each consumer is bounded independently", async () => {
    const timeoutMs = 40;
    const { dispatcher, timeoutResolver } = buildDispatcherFixture(timeoutMs);
    const handler = new HangingHandler();
    const consumer = new Consumer<unknown>("slow-consumer", new TypeRule("foo"), handler, [], []);
    const event = new Event<unknown>("evt-1", "p-1", "pevt-1", NOW, "foo", {});

    await dispatcher.dispatch(event, consumer);

    expect(timeoutResolver.resolveCalls).toEqual(["slow-consumer"]);
  });

  it("applies the default timeout when the resolver returns the default", async () => {
    const { dispatcher, runRepository } = buildDispatcherFixture(DEFAULT_RUN_TIMEOUT_MS);
    const handler = new RecordingHandler(successfulOutcome());
    const consumer = new Consumer<unknown>("c-1", new TypeRule("foo"), handler, [], []);
    const event = new Event<unknown>("evt-1", "p-1", "pevt-1", NOW, "foo", {});

    const finished = await dispatcher.dispatch(event, consumer);

    expect(finished.state).toBe("SUCCEEDED");
    expect(runRepository.getById(finished.id)).resolves.toBeDefined();
  });
});
