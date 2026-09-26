import { describe, it, expect } from "vitest";

import type { EventSink } from "../src/domain/ports/in/event-sink";
import type { Registration } from "../src/domain/ports/in/registration";
import type { IdGenerator } from "../src/domain/ports/out/id-generator";
import type { Clock } from "../src/domain/ports/out/clock";
import type { ContextResolver } from "../src/domain/ports/out/context-resolver";
import type { Event } from "../src/domain/entities/event";
import { UnexpectedStateError } from "../src/domain/exceptions/errors";

import { InlineProducer } from "../src/infra/adapters/producers/inline/inline-producer";
import { FixedClock, SequentialIdGenerator } from "./helpers";

class RecordingSink implements EventSink {
  public readonly events: Event<unknown>[] = [];

  public async emit(event: Event<unknown>): Promise<void> {
    this.events.push(event);
  }

  public async emitDetached(event: Event<unknown>): Promise<void> {
    this.events.push(event);
  }
}

function registrationWith(
  idGenerator: IdGenerator,
  clock: Clock,
  addProducer: (producer: InlineProducer) => void,
): Registration {
  return {
    idGenerator,
    clock,
    contexts: {} as ContextResolver,
    addProducer: (producer) => addProducer(producer as unknown as InlineProducer),
    addConsumer: () => {},
  };
}

describe("InlineProducer", () => {
  it("emits an event carrying its own producerId, the given type and payload", async () => {
    const sink = new RecordingSink();
    const idGenerator = new SequentialIdGenerator();
    const clock = new FixedClock(new Date("2026-07-04T00:00:00Z"));
    const producer = new InlineProducer("pr-validation");

    let registered: InlineProducer | null = null;
    producer.register(registrationWith(idGenerator, clock, (p) => (registered = p)));
    expect(registered).toBe(producer);

    await producer.start(sink);

    await producer.emit("pevt-1", "pr.validation_succeeded", { hello: "world" });

    expect(sink.events).toHaveLength(1);
    const event = sink.events[0];
    expect(event.id).toBe("id-1");
    expect(event.producerId).toBe("pr-validation");
    expect(event.producerEventId).toBe("pevt-1");
    expect(event.datetime).toEqual(new Date("2026-07-04T00:00:00Z"));
    expect(event.type).toBe("pr.validation_succeeded");
    expect(event.payload).toEqual({ hello: "world" });
  });

  it("throws when emit is called before start provides a sink", async () => {
    const idGenerator = new SequentialIdGenerator();
    const clock = new FixedClock(new Date("2026-07-04T00:00:00Z"));
    const producer = new InlineProducer("pr-validation");

    producer.register(registrationWith(idGenerator, clock, () => {}));

    await expect(producer.emit("pevt-1", "pr.validation_succeeded", {})).rejects.toBeInstanceOf(UnexpectedStateError);
  });

  it("clears the sink on stop so subsequent emit calls throw", async () => {
    const sink = new RecordingSink();
    const idGenerator = new SequentialIdGenerator();
    const clock = new FixedClock(new Date("2026-07-04T00:00:00Z"));
    const producer = new InlineProducer("pr-validation");

    producer.register(registrationWith(idGenerator, clock, () => {}));
    await producer.start(sink);
    await producer.stop();

    await expect(producer.emit("pevt-1", "pr.validation_succeeded", {})).rejects.toBeInstanceOf(UnexpectedStateError);
  });
});
