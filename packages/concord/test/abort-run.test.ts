import { describe, it, expect } from "vitest";

import { Event } from "../src/domain/entities/event";
import { Run, type RunState } from "../src/domain/entities/run";
import { Consumer } from "../src/domain/entities/consumer";
import type { RunRepository } from "../src/domain/ports/out/run-repository";
import type { Clock } from "../src/domain/ports/out/clock";
import type { Result } from "../src/domain/result";
import { failure } from "../src/domain/result";
import type { ListQuery, ListResult } from "../src/domain/list";
import type { ConcordError } from "../src/domain/exceptions/errors";
import {
  EventHandlerError,
  RunNotFoundError,
  RunNotAbortableError,
} from "../src/domain/exceptions/errors";
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
} from "./helpers";

const NOW = new Date("2026-07-05T12:00:00Z");

class InterceptedRunRepository implements RunRepository {
  public constructor(
    private readonly inner: RunRepository,
    private readonly onRunningSaved: (runId: string) => void,
  ) {}

  public async save(run: Run<unknown>): Promise<Result<void, ConcordError>> {
    const result = await this.inner.save(run);
    if (run.state === "RUNNING") {
      this.onRunningSaved(run.id);
    }
    return result;
  }

  public async getById(id: string): Promise<Run<unknown>> {
    return this.inner.getById(id);
  }

  public async list(query: ListQuery): Promise<ListResult<Run<unknown>>> {
    return this.inner.list(query);
  }

  public async listByEventId(eventId: string, query: ListQuery): Promise<ListResult<Run<unknown>>> {
    return this.inner.listByEventId(eventId, query);
  }

  public async listByState(state: RunState, query: ListQuery): Promise<ListResult<Run<unknown>>> {
    return this.inner.listByState(state, query);
  }

  public async listByConsumer(consumerId: string, query: ListQuery): Promise<ListResult<Run<unknown>>> {
    return this.inner.listByConsumer(consumerId, query);
  }
}

function buildDispatcherFixture(overrides: { readonly onRunningSaved?: (runId: string) => void } = {}) {
  const inner = new InMemoryRunRepository();
  const runRepository: RunRepository = overrides.onRunningSaved !== undefined
    ? new InterceptedRunRepository(inner, overrides.onRunningSaved)
    : inner;
  const abortRegistry = new InMemoryRunAbortRegistry();
  const observer = new NoOpEventLifecycleObserver();
  const idGenerator = new SequentialIdGenerator();
  const clock = new (class implements Clock { public now(): Date { return NOW; } })();
  const dispatcher = buildDispatcher({ runRepository, idGenerator, observer, abortRegistry, clock });
  const abort = new AbortRunInteractor(runRepository, abortRegistry, observer);
  return { dispatcher, abort, runRepository: inner, abortRegistry };
}

describe("AbortRunInteractor", () => {
  it("transitions a RUNNING run to ABORTED and the handler observes signal.aborted", async () => {
    const { dispatcher, abort } = buildDispatcherFixture();
    const handler = new HangingHandler();
    const consumer = new Consumer<unknown>("c-1", new TypeRule("foo"), handler, [], []);
    const event = new Event<unknown>("evt-1", "p-1", "pevt-1", NOW, "foo", {});

    const dispatchPromise = dispatcher.dispatch(event, consumer);
    await waitFor(() => (handler.calls.length > 0 ? handler.calls : undefined));

    const aborted = await abort.abort(handler.calls[0].id);
    await dispatchPromise;

    expect(aborted.state).toBe("ABORTED");
    expect(aborted.id).toBe(handler.calls[0].id);
    await waitFor(() => (handler.observed.length > 0 ? handler.observed : undefined));
    expect(handler.observed[0].aborted).toBe(true);
  });

  it("aborts a run before the handler is invoked, transitioning it to ABORTED with zero handler calls", async () => {
    let pending: ((runId: string) => void) | null = null;

    const abortRegistry = new InMemoryRunAbortRegistry();
    const innerRepository = new InMemoryRunRepository();
    const observer = new NoOpEventLifecycleObserver();
    const idGenerator = new SequentialIdGenerator();
    const clock = new (class implements Clock { public now(): Date { return NOW; } })();
    const dispatcher = buildDispatcher({
      runRepository: new InterceptedRunRepository(innerRepository, (runId: string) => {
        pending?.(runId);
      }),
      idGenerator,
      observer,
      abortRegistry,
      clock,
    });
    const abort = new AbortRunInteractor(innerRepository, abortRegistry, observer);

    const handler = new HangingHandler();
    const consumer = new Consumer<unknown>("c-1", new TypeRule("foo"), handler, [], []);
    const event = new Event<unknown>("evt-1", "p-1", "pevt-1", NOW, "foo", {});

    const abortGate = new Promise<void>((resolve) => {
      pending = (runId: string) => {
        const handle = abortRegistry.lookup(runId);
        if (handle !== null) {
          handle.controller.abort();
          void abort.abort(runId).then(() => resolve());
        }
      };
    });

    const dispatchPromise = dispatcher.dispatch(event, consumer);
    await abortGate;
    const finished = await dispatchPromise;

    expect(finished.state).toBe("ABORTED");
    expect(handler.calls).toHaveLength(0);
  });

  it("throws RunNotAbortableError when aborting a run in a terminal state", async () => {
    const { dispatcher, abort } = buildDispatcherFixture();
    const handler = new RecordingHandler(successfulOutcome());
    const consumer = new Consumer<unknown>("c-1", new TypeRule("foo"), handler, [], []);
    const event = new Event<unknown>("evt-1", "p-1", "pevt-1", NOW, "foo", {});

    const finished = await dispatcher.dispatch(event, consumer);
    expect(finished.state).toBe("SUCCEEDED");

    await expect(abort.abort(finished.id)).rejects.toBeInstanceOf(RunNotAbortableError);
  });

  it("throws RunNotFoundError when aborting an unknown run id", async () => {
    const { abort } = buildDispatcherFixture();
    await expect(abort.abort("does-not-exist")).rejects.toBeInstanceOf(RunNotFoundError);
  });

  it("overrides a successful handler outcome with ABORTED when the signal is aborted", async () => {
    const { dispatcher, abort } = buildDispatcherFixture();
    const handler = new HangingHandler(successfulOutcome());
    const consumer = new Consumer<unknown>("c-1", new TypeRule("foo"), handler, [], []);
    const event = new Event<unknown>("evt-1", "p-1", "pevt-1", NOW, "foo", {});

    const dispatchPromise = dispatcher.dispatch(event, consumer);
    await waitFor(() => (handler.calls.length > 0 ? handler.calls : undefined));

    const aborted = await abort.abort(handler.calls[0].id);
    await dispatchPromise;

    expect(aborted.state).toBe("ABORTED");
  });

  it("returns the run in its terminal ABORTED state from the completion promise", async () => {
    const { dispatcher, abort } = buildDispatcherFixture();
    const handler = new HangingHandler(failure<void, EventHandlerError>(new EventHandlerError("ignored")));
    const consumer = new Consumer<unknown>("c-1", new TypeRule("foo"), handler, [], []);
    const event = new Event<unknown>("evt-1", "p-1", "pevt-1", NOW, "foo", {});

    const dispatchPromise = dispatcher.dispatch(event, consumer);
    await waitFor(() => (handler.calls.length > 0 ? handler.calls : undefined));

    const aborted = await abort.abort(handler.calls[0].id);
    await dispatchPromise;

    expect(aborted.state).toBe("ABORTED");
    expect(aborted.failure).toBeNull();
  });
});
