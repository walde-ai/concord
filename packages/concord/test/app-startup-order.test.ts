import { describe, it, expect } from "vitest";
import { MakeApp } from "../src/infra/main/make-app";
import { InMemoryEventStore } from "../src/infra/adapters/stores/in-memory-event-store";
import { InMemoryRunRepository } from "../src/infra/adapters/stores/in-memory-run-repository";
import { InMemoryConsumerStateRepository } from "../src/infra/adapters/stores/in-memory-consumer-state-repository";
import { noopLogger } from "../src/domain/ports/out/logger";
import { Consumer } from "../src/domain/entities/consumer";
import { InlineProducer } from "../src/infra/adapters/producers/inline/inline-producer";
import { Event } from "../src/domain/entities/event";
import { Run } from "../src/domain/entities/run";
import { success } from "../src/domain/result";
import { TypeRule } from "./helpers";
import type { Registrable } from "../src/domain/ports/in/registrable";
import type { Registration } from "../src/domain/ports/in/registration";
import type { Handler } from "../src/domain/ports/in/handler";
import type { Run as RunEntity } from "../src/domain/entities/run";
import type { Result } from "../src/domain/result";
import type { EventHandlerError } from "../src/domain/exceptions/errors";

// A consumer that emits through its own InlineProducer, exactly like the
// deployment's agent consumers (pr-verify, pr-rework, ...): the emit works
// only once the producer-start phase of App.start() has completed. Production
// incident (2026-11-17): the off-peak drain at startup raced producer start
// and the resumed pr-verify run failed within two seconds with
// `InlineProducer "pr-verify" has not been started`.
class EmittingConsumer implements Registrable, Handler<unknown> {
  public readonly handled: string[] = [];
  private readonly producer = new InlineProducer("startup-order-producer");

  public register(registration: Registration): void {
    this.producer.register(registration);
    registration.addConsumer(
      new Consumer<unknown>("c-parked", new TypeRule("startup.order.ping"), this, [], []),
    );
  }

  public async handle(run: RunEntity<unknown>, _signal: AbortSignal): Promise<Result<void, EventHandlerError>> {
    this.handled.push(run.id);
    await this.producer.emit(`emitted/${run.id}`, "startup.order.emitted", { runId: run.id });
    return success(undefined);
  }
}

describe("App startup order", () => {
  it("drains a parked WAIT_FOR_OFFPEAK run only after producers started, so the resumed handler can emit", async () => {
    const eventStore = new InMemoryEventStore();
    const runRepository = new InMemoryRunRepository();
    const consumerStates = new InMemoryConsumerStateRepository();
    const consumer = new EmittingConsumer();

    const app = MakeApp({
      eventStore,
      runRepository,
      consumerStateRepository: consumerStates,
      logger: noopLogger,
    });
    app.register(consumer);

    // A parked run from a previous process: its consumer opted into off-peak
    // deferral, the dispatcher parked it mid-peak, and the process restarted
    // before the window opened. No peak window is configured now, so
    // App.start()'s off-peak drain resumes the run.
    await consumerStates.setWaitForOffPeak("c-parked", true);
    const event = new Event<unknown>(
      "evt-parked-1",
      "test",
      "pe-parked-1",
      new Date("2026-11-17T08:57:00Z"),
      "startup.order.ping",
      {},
    );
    await eventStore.save(event);
    const parked = new Run<unknown>("run-parked-1", event, "c-parked");
    parked.markWaitingForOffPeak();
    await runRepository.save(parked);

    await app.start();
    await app.awaitRuns();

    const drained = await runRepository.getById("run-parked-1");
    expect(drained?.state).toBe("SUCCEEDED");
    expect(consumer.handled.length).toBeGreaterThanOrEqual(1);
    const emitted = await eventStore.existsByProducerKey("startup-order-producer", `emitted/${consumer.handled[0]}`);
    expect(emitted).toBe(true);

    await app.stop();
  });
});
