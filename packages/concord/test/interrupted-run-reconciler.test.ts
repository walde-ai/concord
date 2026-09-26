import { describe, it, expect } from "vitest";

import { Event } from "../src/domain/entities/event";
import { Run } from "../src/domain/entities/run";
import { Consumer } from "../src/domain/entities/consumer";
import { InterruptedRunReconciler } from "../src/domain/interactors/interrupted-run-reconciler";
import { InMemoryRunRepository } from "../src/infra/adapters/stores/in-memory-run-repository";
import { InMemoryConsumerStateRepository } from "../src/infra/adapters/stores/in-memory-consumer-state-repository";
import { InMemoryConsumerRegistry } from "../src/infra/adapters/registry/in-memory-consumer-registry";
import { NoOpEventLifecycleObserver } from "../src/infra/adapters/api/no-op-event-lifecycle-observer";
import type { Logger, LogLevel, LogEntry } from "../src/domain/ports/out/logger";
import { TypeRule, RecordingHandler, successfulOutcome, FixedClock, SequentialIdGenerator, buildDispatcher } from "./helpers";

const NOW = new Date("2026-07-06T08:00:00Z");
const CONSUMER_ID = "c-1";
const EVENT_TYPE = "foo";

class FixedClockImpl extends FixedClock {}

class RecordingLogger implements Logger {
  public readonly entries: LogEntry[] = [];

  public log(entry: LogEntry): void {
    this.entries.push(entry);
  }

  public debug(source: string, message: string, fields?: Readonly<Record<string, unknown>>): void {
    this.entries.push({ timestamp: NOW.toISOString(), level: "debug" as LogLevel, source, message, fields });
  }

  public info(source: string, message: string, fields?: Readonly<Record<string, unknown>>): void {
    this.entries.push({ timestamp: NOW.toISOString(), level: "info" as LogLevel, source, message, fields });
  }

  public warn(source: string, message: string, fields?: Readonly<Record<string, unknown>>): void {
    this.entries.push({ timestamp: NOW.toISOString(), level: "warn" as LogLevel, source, message, fields });
  }

  public error(source: string, message: string, fields?: Readonly<Record<string, unknown>>): void {
    this.entries.push({ timestamp: NOW.toISOString(), level: "error" as LogLevel, source, message, fields });
  }
}

function makeEvent(idSuffix: string): Event<unknown> {
  return new Event<unknown>("evt-" + idSuffix, "p-1", "pevt-" + idSuffix, NOW, EVENT_TYPE, {});
}

function makeRun(id: string, state: Run<unknown>["state"]): Run<unknown> {
  return new Run<unknown>(id, makeEvent(id), CONSUMER_ID, state, null);
}

interface Fixture {
  readonly repository: InMemoryRunRepository;
  readonly registry: InMemoryConsumerRegistry;
  readonly consumerStateRepository: InMemoryConsumerStateRepository;
  readonly handler: RecordingHandler;
  readonly dispatcher: ReturnType<typeof buildDispatcher>;
  readonly logger: RecordingLogger;
  readonly reconciler: InterruptedRunReconciler;
}

function buildFixture(): Fixture {
  const repository = new InMemoryRunRepository();
  const registry = new InMemoryConsumerRegistry();
  const consumerStateRepository = new InMemoryConsumerStateRepository();
  const handler = new RecordingHandler(successfulOutcome());
  registry.register(new Consumer<unknown>(CONSUMER_ID, new TypeRule(EVENT_TYPE), handler, [], []));
  const dispatcher = buildDispatcher({
    runRepository: repository,
    idGenerator: new SequentialIdGenerator(),
    clock: new FixedClockImpl(NOW),
    consumerStateRepository,
    consumerRegistry: registry,
  });
  const logger = new RecordingLogger();
  const reconciler = new InterruptedRunReconciler(
    repository,
    new NoOpEventLifecycleObserver(),
    new FixedClockImpl(NOW),
    registry,
    consumerStateRepository,
    dispatcher,
    logger,
  );
  return { repository, registry, consumerStateRepository, handler, dispatcher, logger, reconciler };
}

describe("InterruptedRunReconciler", () => {
  it("marks a RUNNING orphan FAILED and re-dispatches the work on a fresh run", async () => {
    const fixture = buildFixture();
    await fixture.repository.save(makeRun("r-running", "RUNNING"));

    const count = await fixture.reconciler.reconcile();
    await fixture.dispatcher.awaitDetached();

    expect(count).toBe(1);
    const orphan = await fixture.repository.getById("r-running");
    expect(orphan.state).toBe("FAILED");
    expect(orphan.failure?.errorName).toBe("InterruptedError");
    expect(orphan.finishedAt).toEqual(NOW);

    // A brand-new run was dispatched for the same event and ran to completion.
    expect(fixture.handler.calls).toHaveLength(1);
    const restarted = fixture.handler.calls[0];
    expect(restarted.id).not.toBe("r-running");
    expect(restarted.event.id).toBe("evt-r-running");
    expect(restarted.consumerId).toBe(CONSUMER_ID);
    const persisted = await fixture.repository.getById(restarted.id);
    expect(persisted.state).toBe("SUCCEEDED");
  });

  it("marks a PENDING_INPUT orphan FAILED and re-dispatches the work", async () => {
    const fixture = buildFixture();
    const run = makeRun("r-pending", "RUNNING");
    run.markPendingInput();
    await fixture.repository.save(run);

    const count = await fixture.reconciler.reconcile();
    await fixture.dispatcher.awaitDetached();

    expect(count).toBe(1);
    const orphan = await fixture.repository.getById("r-pending");
    expect(orphan.state).toBe("FAILED");
    expect(orphan.failure?.errorName).toBe("InterruptedError");
    expect(fixture.handler.calls).toHaveLength(1);
    expect(fixture.handler.calls[0].id).not.toBe("r-pending");
  });

  it("leaves WAIT_FOR_OFFPEAK runs untouched (OffPeakScheduler recovers them)", async () => {
    const fixture = buildFixture();
    await fixture.repository.save(makeRun("r-running", "RUNNING"));
    await fixture.repository.save(makeRun("r-parked", "WAIT_FOR_OFFPEAK"));

    const count = await fixture.reconciler.reconcile();
    await fixture.dispatcher.awaitDetached();

    // Only the RUNNING orphan is reconciled.
    expect(count).toBe(1);
    const parked = await fixture.repository.getById("r-parked");
    expect(parked.state).toBe("WAIT_FOR_OFFPEAK");
    expect(parked.failure).toBeNull();
    expect(parked.finishedAt).toBeNull();
    // The parked run was NOT re-dispatched.
    expect(fixture.handler.calls).toHaveLength(1);
    expect(fixture.handler.calls[0].event.id).toBe("evt-r-running");
  });

  it("leaves the orphan FAILED when the consumer is no longer registered", async () => {
    const fixture = buildFixture();
    await fixture.repository.save(makeRun("r-running", "RUNNING"));
    // Simulate the consumer being decommissioned between runs.
    (fixture.registry as unknown as { consumers: Consumer<unknown>[] }).consumers = [];

    const count = await fixture.reconciler.reconcile();
    await fixture.dispatcher.awaitDetached();

    expect(count).toBe(1);
    const orphan = await fixture.repository.getById("r-running");
    expect(orphan.state).toBe("FAILED");
    expect(fixture.handler.calls).toHaveLength(0);
    const warns = fixture.logger.entries.filter((e) => e.level === "warn");
    expect(warns).toHaveLength(1);
    expect(warns[0].message).toContain("no longer registered");
  });

  it("leaves the orphan FAILED when the consumer has been disabled", async () => {
    const fixture = buildFixture();
    await fixture.repository.save(makeRun("r-running", "RUNNING"));
    await fixture.consumerStateRepository.setEnabled(CONSUMER_ID, false);

    const count = await fixture.reconciler.reconcile();
    await fixture.dispatcher.awaitDetached();

    expect(count).toBe(1);
    const orphan = await fixture.repository.getById("r-running");
    expect(orphan.state).toBe("FAILED");
    expect(fixture.handler.calls).toHaveLength(0);
    const warns = fixture.logger.entries.filter((e) => e.level === "warn");
    expect(warns).toHaveLength(1);
    expect(warns[0].message).toContain("disabled");
  });

  it("does nothing when there are no interrupted runs", async () => {
    const fixture = buildFixture();
    await fixture.repository.save(makeRun("r-1", "SUCCEEDED"));
    await fixture.repository.save(makeRun("r-2", "ABORTED"));

    const count = await fixture.reconciler.reconcile();

    expect(count).toBe(0);
    expect(fixture.handler.calls).toHaveLength(0);
  });

  it("does not double-dispatch on repeated reconcile() calls for the same orphan", async () => {
    const fixture = buildFixture();
    await fixture.repository.save(makeRun("r-running", "RUNNING"));

    await fixture.reconciler.reconcile();
    await fixture.dispatcher.awaitDetached();

    // Second reconcile after the orphan has already transitioned to FAILED
    // finds no interrupted runs, so it does not re-dispatch again.
    const count = await fixture.reconciler.reconcile();
    await fixture.dispatcher.awaitDetached();

    expect(count).toBe(0);
    expect(fixture.handler.calls).toHaveLength(1);
  });
});
