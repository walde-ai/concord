import { describe, it, expect } from "vitest";
import type { EventTemplateDescriptor, EventTemplateEmission, FieldOption } from "../src/domain/event-template";
import type { EventTemplate } from "../src/domain/ports/in/event-template";
import type { Registration } from "../src/domain/ports/in/registration";
import type { AnswerMap } from "../src/domain/entities/run-form";
import type { ContextResolver } from "../src/domain/ports/out/context-resolver";
import type { Result } from "../src/domain/result";
import type { ContextResolveError } from "../src/domain/exceptions/errors";
import { InMemoryEventTemplateRegistry } from "../src/infra/adapters/registry/in-memory-event-template-registry";
import { ListEventTemplatesInteractor } from "../src/domain/interactors/list-event-templates-interactor";
import { EmitEventTemplateInteractor } from "../src/domain/interactors/emit-event-template-interactor";
import { RecordingEventSink, SequentialIdGenerator, FixedClock } from "./helpers";
import {
  EventTemplateNotFoundError,
  InvalidEventTemplateAnswersError,
} from "../src/domain/exceptions/errors";
import { RAWJSON } from "../src/infra/adapters/producers/websocket/websocket-producer";
import { RawJsonEventTemplate } from "../src/infra/adapters/event-templates/raw-json-event-template";

const NOW = new Date("2026-07-08T10:00:00Z");

class StubContextResolver implements ContextResolver {
  public async resolve<T>(
    _requester: { readonly kind: "producer" | "consumer"; readonly id: string },
    _name: string,
    _guard: (value: unknown) => value is T,
  ): Promise<Result<{ context: T; secrets: Record<string, string> }, ContextResolveError>> {
    throw new Error("not implemented");
  }
}

const stubContexts = new StubContextResolver();

class StubEventTemplate implements EventTemplate {
  public constructor(
    public readonly id: string,
    public readonly producerId: string,
    public readonly descriptor: EventTemplateDescriptor,
    private readonly buildFn: (answers: AnswerMap) => EventTemplateEmission,
  ) {}

  public register(_registration: Registration): void {}

  public resolveDescriptor(_contexts: ContextResolver): Promise<EventTemplateDescriptor> {
    return Promise.resolve(this.descriptor);
  }

  public resolveFieldOptions(_fieldKey: string, _answers: AnswerMap, _contexts: ContextResolver): Promise<readonly FieldOption[]> {
    return Promise.resolve([]);
  }

  public build(answers: AnswerMap): EventTemplateEmission {
    return this.buildFn(answers);
  }
}

function textDescriptor(id: string, producerId: string, key: string): EventTemplateDescriptor {
  return {
    id,
    label: id,
    description: `template ${id}`,
    producerId,
    fields: [{ key, label: key.toUpperCase(), inputType: "text", defaultValue: "" }],
  };
}

describe("ListEventTemplatesInteractor", () => {
  it("returns the descriptors of every registered template in registration order", async () => {
    const registry = new InMemoryEventTemplateRegistry();
    registry.register(
      new StubEventTemplate("a", "p-a", textDescriptor("a", "p-a", "x"), () => ({
        type: "t",
        payload: {},
        producerEventId: "e",
      })),
    );
    registry.register(
      new StubEventTemplate("b", "p-b", textDescriptor("b", "p-b", "y"), () => ({
        type: "t",
        payload: {},
        producerEventId: "e",
      })),
    );
    const interactor = new ListEventTemplatesInteractor(registry, stubContexts);

    const descriptors = await interactor.list();

    expect(descriptors.map((d) => d.id)).toEqual(["a", "b"]);
  });
});

describe("EmitEventTemplateInteractor", () => {
  it("validates answers, calls build, constructs an Event attributed to the template producerId, emits it, and returns a matching descriptor", async () => {
    const registry = new InMemoryEventTemplateRegistry();
    const sink = new RecordingEventSink();
    const ids = new SequentialIdGenerator();
    const clock = new FixedClock(NOW);
    registry.register(
      new StubEventTemplate("stub", "p-stub", textDescriptor("stub", "p-stub", "name"), (answers) => ({
        type: "stub.event",
        payload: { name: answers.name },
        producerEventId: "stub-pevt",
      })),
    );
    const interactor = new EmitEventTemplateInteractor(registry, sink, ids, clock, stubContexts);

    const descriptor = await interactor.emit("stub", { name: "alice" });

    expect(descriptor.producerId).toBe("p-stub");
    expect(descriptor.producerEventId).toBe("stub-pevt");
    expect(descriptor.type).toBe("stub.event");
    expect(descriptor.payload).toEqual({ name: "alice" });
    expect(descriptor.id).toBe("id-1");
    expect(descriptor.datetime).toBe(NOW);
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0].producerId).toBe("p-stub");
    expect(sink.events[0].producerEventId).toBe("stub-pevt");
  });

  it("throws EventTemplateNotFoundError for an unknown template id", async () => {
    const registry = new InMemoryEventTemplateRegistry();
    const sink = new RecordingEventSink();
    const interactor = new EmitEventTemplateInteractor(
      registry,
      sink,
      new SequentialIdGenerator(),
      new FixedClock(NOW),
      stubContexts,
    );

    await expect(interactor.emit("ghost", { x: "y" })).rejects.toThrow(EventTemplateNotFoundError);
  });

  it("throws InvalidEventTemplateAnswersError for a missing field key", async () => {
    const registry = new InMemoryEventTemplateRegistry();
    const sink = new RecordingEventSink();
    registry.register(
      new StubEventTemplate("stub", "p-stub", textDescriptor("stub", "p-stub", "name"), () => ({
        type: "t",
        payload: {},
        producerEventId: "e",
      })),
    );
    const interactor = new EmitEventTemplateInteractor(
      registry,
      sink,
      new SequentialIdGenerator(),
      new FixedClock(NOW),
      stubContexts,
    );

    await expect(interactor.emit("stub", {})).rejects.toThrow(InvalidEventTemplateAnswersError);
  });

  it("lets an InvalidEventTemplateAnswersError thrown by build propagate unchanged", async () => {
    const registry = new InMemoryEventTemplateRegistry();
    const sink = new RecordingEventSink();
    const descriptor = textDescriptor("stub", "p-stub", "name");
    registry.register(
      new StubEventTemplate("stub", "p-stub", descriptor, () => {
        throw new InvalidEventTemplateAnswersError("build failed");
      }),
    );
    const interactor = new EmitEventTemplateInteractor(
      registry,
      sink,
      new SequentialIdGenerator(),
      new FixedClock(NOW),
      stubContexts,
    );

    await expect(interactor.emit("stub", { name: "x" })).rejects.toThrow(
      InvalidEventTemplateAnswersError,
    );
  });

  it("carries the emission producerEventId (not a freshly generated id) so the raw-JSON idempotency contract holds", async () => {
    const registry = new InMemoryEventTemplateRegistry();
    const sink = new RecordingEventSink();
    const ids = new SequentialIdGenerator();
    registry.register(new RawJsonEventTemplate());
    const interactor = new EmitEventTemplateInteractor(registry, sink, ids, new FixedClock(NOW), stubContexts);

    const descriptor = await interactor.emit("raw-json", {
      json: JSON.stringify({ eventId: "pevt-1", hello: "world" }),
    });

    expect(descriptor.producerEventId).toBe("pevt-1");
    expect(descriptor.type).toBe(RAWJSON);
    expect(descriptor.payload).toEqual({ eventId: "pevt-1", hello: "world" });
    expect(sink.events[0].producerEventId).toBe("pevt-1");
  });
});
