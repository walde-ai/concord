import { describe, it, expect } from "vitest";
import {
  FixedClock,
  SequentialIdGenerator,
  TypeRule,
  FixedRunTimeoutResolver,
} from "./helpers";
import { SystemClock } from "../src/infra/adapters/system/system-clock";
import { StructuredLogger } from "../src/infra/adapters/system/structured-logger";
import { AsyncLogContextScope } from "../src/infra/adapters/system/async-log-context-scope";
import { InMemoryLogStore } from "../src/infra/adapters/stores/in-memory-log-store";
import { noopLogContextScope } from "../src/domain/ports/out/log-context";
import type { LogEntry, Logger } from "../src/domain/ports/out/logger";
import type { Handler } from "../src/domain/ports/out/handler";
import { RunDispatcher } from "../src/domain/interactors/run-dispatcher";
import { NoOpRunCompletionHook } from "../src/domain/ports/out/run-completion-hook";
import { InMemoryRunRepository } from "../src/infra/adapters/stores/in-memory-run-repository";
import { InMemoryConsumerStateRepository } from "../src/infra/adapters/stores/in-memory-consumer-state-repository";
import { InMemoryPeakHoursRepository } from "../src/infra/adapters/stores/in-memory-peak-hours-repository";
import { InMemoryConsumerRegistry } from "../src/infra/adapters/registry/in-memory-consumer-registry";
import { InMemoryRunAbortRegistry } from "../src/infra/adapters/registry/in-memory-run-abort-registry";
import { InMemoryRunTimeoutClock } from "../src/infra/adapters/registry/in-memory-run-timeout-clock";
import { NoOpEventLifecycleObserver } from "../src/infra/adapters/api/no-op-event-lifecycle-observer";
import { Consumer } from "../src/domain/entities/consumer";
import { Event } from "../src/domain/entities/event";
import { Run } from "../src/domain/entities/run";
import { success } from "../src/domain/result";
import type { Result } from "../src/domain/result";
import type { EventHandlerError } from "../src/domain/exceptions/errors";
import { DEFAULT_RUN_TIMEOUT_MS } from "../src/domain/ports/out/run-timeout-resolver";

const CLOCK = new FixedClock(new Date("2026-07-11T10:00:00Z"));

describe("StructuredLogger log-context enrichment", () => {
  it("emits no enrichment fields when no context is active", async () => {
    const store = new InMemoryLogStore();
    const logger = new StructuredLogger(CLOCK, noopLogContextScope, store);

    logger.info("unit", "starting");

    const result = await store.query({ limit: 10, offset: 0 });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].fields).toBeUndefined();
  });

  it("merges eventId/runId/consumerId into every entry while a context is active", async () => {
    const store = new InMemoryLogStore();
    const scope = new AsyncLogContextScope();
    const logger = new StructuredLogger(CLOCK, scope, store);

    await scope.run(
      { eventId: "evt-1", runId: "run-1", consumerId: "c-1" },
      async () => {
        logger.info("unit", "first");
        await Promise.resolve();
        logger.warn("unit", "second", { extra: "kept" });
      },
    );

    const result = await store.query({ limit: 10, offset: 0 });
    expect(result.items.map((entry) => entry.message).sort()).toEqual(["first", "second"]);
    for (const entry of result.items) {
      expect(entry.fields).toMatchObject({
        eventId: "evt-1",
        runId: "run-1",
        consumerId: "c-1",
      });
    }
    expect(result.items[1].fields?.extra).toBe("kept");
  });

  it("preserves call-site fields over the inherited context", async () => {
    const store = new InMemoryLogStore();
    const scope = new AsyncLogContextScope();
    const logger = new StructuredLogger(CLOCK, scope, store);

    await scope.run({ eventId: "evt-1", runId: "run-1" }, async () => {
      logger.error("unit", "overridden", { runId: "run-explicit" });
    });

    const result = await store.query({ limit: 10, offset: 0 });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].fields).toMatchObject({ eventId: "evt-1", runId: "run-explicit" });
  });

  it("clears the context once the scoped callback resolves", async () => {
    const store = new InMemoryLogStore();
    const scope = new AsyncLogContextScope();
    const logger = new StructuredLogger(CLOCK, scope, store);

    await scope.run({ eventId: "evt-1", runId: "run-1" }, async () => {
      logger.info("unit", "inside");
    });
    logger.info("unit", "outside");

    const result = await store.query({ limit: 10, offset: 0 });
    const outside = result.items.find((entry) => entry.message === "outside");
    const inside = result.items.find((entry) => entry.message === "inside");
    expect(outside?.fields).toBeUndefined();
    expect(inside?.fields).toMatchObject({ eventId: "evt-1", runId: "run-1" });
  });

  it("isolates the context across concurrent async chains", async () => {
    const store = new InMemoryLogStore();
    const scope = new AsyncLogContextScope();
    const logger = new StructuredLogger(new SystemClock(), scope, store);

    await Promise.all([
      scope.run({ eventId: "evt-a", runId: "run-a" }, async () => {
        await Promise.resolve();
        logger.info("unit", "a");
      }),
      scope.run({ eventId: "evt-b", runId: "run-b" }, async () => {
        await Promise.resolve();
        logger.info("unit", "b");
      }),
    ]);

    const result = await store.query({ limit: 10, offset: 0 });
    const byMessage = new Map<string, LogEntry>();
    for (const entry of result.items) {
      byMessage.set(entry.message, entry);
    }
    expect(byMessage.get("a")?.fields).toMatchObject({ eventId: "evt-a", runId: "run-a" });
    expect(byMessage.get("b")?.fields).toMatchObject({ eventId: "evt-b", runId: "run-b" });
  });
});

class LoggingHandler implements Handler<unknown> {
  public readonly runIds: string[] = [];

  public constructor(private readonly logger: Logger) {}

  public async handle(run: Run<unknown>, _signal: AbortSignal): Promise<Result<void, EventHandlerError>> {
    this.runIds.push(run.id);
    // Emulate the deep, async call tree of a real run: a couple of awaits that
    // cross async boundaries before logging. The context must still be present.
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    this.logger.info("logging-handler", "handled run", { step: "deep-inside" });
    return success(undefined);
  }
}

describe("RunDispatcher log-context enrichment", () => {
  it("attaches eventId/runId/consumerId to logs emitted deep inside the handler", async () => {
    const store = new InMemoryLogStore();
    const scope = new AsyncLogContextScope();
    const clock = new FixedClock(new Date("2026-07-11T10:00:00Z"));
    const logger = new StructuredLogger(clock, scope, store);
    const handler = new LoggingHandler(logger);

    const registry = new InMemoryConsumerRegistry();
    registry.register(new Consumer<unknown>("c-1", new TypeRule("foo"), handler, [], []));

    const dispatcher = new RunDispatcher(
      new InMemoryRunRepository(),
      new SequentialIdGenerator(),
      new NoOpEventLifecycleObserver(),
      new InMemoryRunAbortRegistry(),
      clock,
      new InMemoryPeakHoursRepository(),
      { isPeakAt: () => false, nextOffPeakBoundary: () => null },
      new InMemoryConsumerStateRepository(),
      registry,
      new FixedRunTimeoutResolver(DEFAULT_RUN_TIMEOUT_MS),
      new InMemoryRunTimeoutClock(),
      logger,
      scope,
      new NoOpRunCompletionHook(),
    );

    const event = new Event<unknown>("evt-1", "p-1", "pevt-1", clock.now(), "foo", {});
    await dispatcher.dispatch(event, registry.all()[0]);

    expect(handler.runIds).toEqual(["id-1"]);
    const result = await store.query({ limit: 10, offset: 0 });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].source).toBe("logging-handler");
    expect(result.items[0].fields).toMatchObject({
      eventId: "evt-1",
      runId: "id-1",
      consumerId: "c-1",
      step: "deep-inside",
    });
  });
});
