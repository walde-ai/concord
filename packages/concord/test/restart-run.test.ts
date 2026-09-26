import { describe, it, expect } from "vitest";

import { Event } from "../src/domain/entities/event";
import { Run } from "../src/domain/entities/run";
import { Consumer } from "../src/domain/entities/consumer";
import {
  RunNotFoundError,
  RunNotRestartableError,
  ConsumerNotFoundError,
  ConsumerDisabledError,
} from "../src/domain/exceptions/errors";
import { RestartRunInteractor } from "../src/domain/interactors/restart-run-interactor";
import { InMemoryRunRepository } from "../src/infra/adapters/stores/in-memory-run-repository";
import { InMemoryConsumerStateRepository } from "../src/infra/adapters/stores/in-memory-consumer-state-repository";
import { InMemoryConsumerRegistry } from "../src/infra/adapters/registry/in-memory-consumer-registry";
import { NoOpEventLifecycleObserver } from "../src/infra/adapters/api/no-op-event-lifecycle-observer";
import {
  FixedClock,
  RecordingHandler,
  SequentialIdGenerator,
  TypeRule,
  buildDispatcher,
  successfulOutcome,
} from "./helpers";

const NOW = new Date("2026-07-05T12:00:00Z");

function buildFixture() {
  const runRepository = new InMemoryRunRepository();
  const consumerRegistry = new InMemoryConsumerRegistry();
  const consumerStateRepository = new InMemoryConsumerStateRepository();
  const idGenerator = new SequentialIdGenerator();
  const observer = new NoOpEventLifecycleObserver();
  const clock = new FixedClock(NOW);
  const dispatcher = buildDispatcher({ runRepository, idGenerator, observer, clock, consumerRegistry, consumerStateRepository });
  const restart = new RestartRunInteractor(runRepository, consumerRegistry, consumerStateRepository, dispatcher);
  return { runRepository, consumerRegistry, consumerStateRepository, restart, dispatcher };
}

describe("RestartRunInteractor", () => {
  it("restarts a SUCCEEDED run by creating a fresh dispatched run for the same event and consumer", async () => {
    const { runRepository, consumerRegistry, restart, dispatcher } = buildFixture();
    const handler = new RecordingHandler(successfulOutcome());
    const consumer = new Consumer<unknown>("c-1", new TypeRule("foo"), handler, [], []);
    consumerRegistry.register(consumer);

    const event = new Event<unknown>("evt-1", "p-1", "pevt-1", NOW, "foo", { n: 1 });
    await runRepository.save(new Run("run-source", event, "c-1", "SUCCEEDED"));

    const restarted = await restart.restart("run-source");

    expect(restarted.id).not.toBe("run-source");
    expect(restarted.consumerId).toBe("c-1");
    expect(restarted.event.id).toBe("evt-1");
    expect(restarted.state).toBe("RUNNING");

    await dispatcher.awaitDetached();

    expect(restarted.state).toBe("SUCCEEDED");
    expect(handler.calls).toHaveLength(1);
    expect(handler.calls[0].event.id).toBe("evt-1");
  });

  it("restarts a FAILED run and lets the new run reach a terminal state", async () => {
    const { runRepository, consumerRegistry, restart, dispatcher } = buildFixture();
    const handler = new RecordingHandler(successfulOutcome());
    const consumer = new Consumer<unknown>("c-1", new TypeRule("foo"), handler, [], []);
    consumerRegistry.register(consumer);

    const event = new Event<unknown>("evt-1", "p-1", "pevt-1", NOW, "foo", {});
    await runRepository.save(new Run("run-failed", event, "c-1", "FAILED"));

    const restarted = await restart.restart("run-failed");
    expect(restarted.state).toBe("RUNNING");
    await dispatcher.awaitDetached();
    expect(restarted.state).toBe("SUCCEEDED");
    expect(restarted.id).not.toBe("run-failed");
  });

  it("restarts an ABORTED run", async () => {
    const { runRepository, consumerRegistry, restart, dispatcher } = buildFixture();
    const handler = new RecordingHandler(successfulOutcome());
    const consumer = new Consumer<unknown>("c-1", new TypeRule("foo"), handler, [], []);
    consumerRegistry.register(consumer);

    const event = new Event<unknown>("evt-1", "p-1", "pevt-1", NOW, "foo", {});
    await runRepository.save(new Run("run-aborted", event, "c-1", "ABORTED"));

    const restarted = await restart.restart("run-aborted");
    expect(restarted.state).toBe("RUNNING");
    await dispatcher.awaitDetached();
    expect(restarted.state).toBe("SUCCEEDED");
  });

  it("restarts a TIMED_OUT run", async () => {
    const { runRepository, consumerRegistry, restart, dispatcher } = buildFixture();
    const handler = new RecordingHandler(successfulOutcome());
    const consumer = new Consumer<unknown>("c-1", new TypeRule("foo"), handler, [], []);
    consumerRegistry.register(consumer);

    const event = new Event<unknown>("evt-1", "p-1", "pevt-1", NOW, "foo", {});
    await runRepository.save(new Run("run-timed-out", event, "c-1", "TIMED_OUT"));

    const restarted = await restart.restart("run-timed-out");
    expect(restarted.state).toBe("RUNNING");
    await dispatcher.awaitDetached();
    expect(restarted.state).toBe("SUCCEEDED");
  });

  it("refuses to restart a RUNNING run with RunNotRestartableError", async () => {
    const { runRepository, consumerRegistry, restart } = buildFixture();
    consumerRegistry.register(new Consumer<unknown>("c-1", new TypeRule("foo"), new RecordingHandler(successfulOutcome()), [], []));

    const event = new Event<unknown>("evt-1", "p-1", "pevt-1", NOW, "foo", {});
    await runRepository.save(new Run("run-running", event, "c-1", "RUNNING"));

    await expect(restart.restart("run-running")).rejects.toBeInstanceOf(RunNotRestartableError);
  });

  it("refuses to restart a PENDING_INPUT run with RunNotRestartableError", async () => {
    const { runRepository, consumerRegistry, restart } = buildFixture();
    consumerRegistry.register(new Consumer<unknown>("c-1", new TypeRule("foo"), new RecordingHandler(successfulOutcome()), [], []));

    const event = new Event<unknown>("evt-1", "p-1", "pevt-1", NOW, "foo", {});
    const run = new Run("run-pending", event, "c-1", "RUNNING");
    run.markPendingInput();
    await runRepository.save(run);

    await expect(restart.restart("run-pending")).rejects.toBeInstanceOf(RunNotRestartableError);
  });

  it("surfaces RunNotFoundError for an unknown run id", async () => {
    const { restart } = buildFixture();
    await expect(restart.restart("missing")).rejects.toBeInstanceOf(RunNotFoundError);
  });

  it("throws ConsumerNotFoundError when the original consumer is no longer registered", async () => {
    const { runRepository, restart } = buildFixture();
    const event = new Event<unknown>("evt-1", "p-1", "pevt-1", NOW, "foo", {});
    await runRepository.save(new Run("run-1", event, "c-removed", "SUCCEEDED"));

    await expect(restart.restart("run-1")).rejects.toBeInstanceOf(ConsumerNotFoundError);
  });

  it("throws ConsumerDisabledError when the original consumer is registered but disabled", async () => {
    const { runRepository, consumerRegistry, consumerStateRepository, restart } = buildFixture();
    consumerRegistry.register(new Consumer<unknown>("c-1", new TypeRule("foo"), new RecordingHandler(successfulOutcome()), [], []));
    await consumerStateRepository.setEnabled("c-1", false);

    const event = new Event<unknown>("evt-1", "p-1", "pevt-1", NOW, "foo", {});
    await runRepository.save(new Run("run-1", event, "c-1", "SUCCEEDED"));

    await expect(restart.restart("run-1")).rejects.toBeInstanceOf(ConsumerDisabledError);
  });

  it("produces a fresh run that receives a fresh AbortSignal", async () => {
    const { runRepository, consumerRegistry, restart, dispatcher } = buildFixture();
    const handler = new RecordingHandler(successfulOutcome());
    const consumer = new Consumer<unknown>("c-1", new TypeRule("foo"), handler, [], []);
    consumerRegistry.register(consumer);

    const event = new Event<unknown>("evt-1", "p-1", "pevt-1", NOW, "foo", {});
    await runRepository.save(new Run("run-1", event, "c-1", "SUCCEEDED"));

    const restarted = await restart.restart("run-1");
    expect(restarted.state).toBe("RUNNING");
    await dispatcher.awaitDetached();
    expect(restarted.state).toBe("SUCCEEDED");
    expect(handler.signals).toHaveLength(1);
    expect(handler.signals[0].aborted).toBe(false);
  });
});
