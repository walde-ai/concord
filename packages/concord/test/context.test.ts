import { describe, it, expect } from "vitest";

import { Context } from "../src/domain/entities/context";
import {
  ContextAlreadyExistsError,
  ContextNotFoundError,
} from "../src/domain/exceptions/errors";
import { InMemoryContextStore } from "../src/infra/adapters/stores/in-memory-context-store";
import { InMemoryEventStore } from "../src/infra/adapters/stores/in-memory-event-store";
import { EventEmittingContextResolver, ERROR_CONTEXT, CONCORD_PRODUCER_ID } from "../src/infra/adapters/context/event-emitting-context-resolver";
import { CreateContextInteractor } from "../src/domain/interactors/create-context-interactor";
import { UpdateContextInteractor } from "../src/domain/interactors/update-context-interactor";
import { DeleteContextInteractor } from "../src/domain/interactors/delete-context-interactor";
import { ListContextsInteractor } from "../src/domain/interactors/list-contexts-interactor";
import { SignalEventInteractor } from "../src/domain/interactors/signal-event-interactor";
import { InMemoryRunRepository } from "../src/infra/adapters/stores/in-memory-run-repository";
import { InMemoryProducerStateRepository } from "../src/infra/adapters/stores/in-memory-producer-state-repository";
import { InMemoryConsumerStateRepository } from "../src/infra/adapters/stores/in-memory-consumer-state-repository";
import { InMemoryConsumerRegistry } from "../src/infra/adapters/registry/in-memory-consumer-registry";
import { InMemoryRunAbortRegistry } from "../src/infra/adapters/registry/in-memory-run-abort-registry";
import { InMemoryPauseStateRepository } from "../src/infra/adapters/stores/in-memory-pause-state-repository";
import { NoOpEventLifecycleObserver } from "../src/infra/adapters/api/no-op-event-lifecycle-observer";
import { RunDispatcher } from "../src/domain/interactors/run-dispatcher";
import { FixedClock, SequentialIdGenerator, buildDispatcher } from "./helpers";

interface Shape {
  readonly hello: string;
}

function isShape(value: unknown): value is Shape {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { hello?: unknown }).hello === "string"
  );
}

function buildResolver(): {
  readonly contextStore: InMemoryContextStore;
  readonly eventStore: InMemoryEventStore;
  readonly resolver: EventEmittingContextResolver;
} {
  const contextStore = new InMemoryContextStore();
  const eventStore = new InMemoryEventStore();
  const runRepository = new InMemoryRunRepository();
  const consumerRegistry = new InMemoryConsumerRegistry();
  const producerStates = new InMemoryProducerStateRepository();
  const consumerStates = new InMemoryConsumerStateRepository();
  const idGenerator = new SequentialIdGenerator();
  const clock = new FixedClock(new Date("2026-07-04T00:00:00Z"));
  const observer = new NoOpEventLifecycleObserver();

  const sink = new SignalEventInteractor(
    eventStore,
    runRepository,
    consumerRegistry,
    producerStates,
    consumerStates,
    idGenerator,
    clock,
    observer,
    new InMemoryPauseStateRepository(),
    buildDispatcher({ runRepository, idGenerator, observer, clock }),
  );

  const resolver = new EventEmittingContextResolver(contextStore, sink, idGenerator, clock);
  return { contextStore, eventStore, resolver };
}

describe("EventEmittingContextResolver contract", () => {
  it("returns a success result carrying the narrowed payload and emits no event", async () => {
    const { contextStore, eventStore, resolver } = buildResolver();
    await contextStore.save(new Context("greeting", { hello: "world" }, {}));

    const result = await resolver.resolve({ kind: "producer", id: "p-1" }, "greeting", isShape);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.context).toEqual({ hello: "world" });
      expect(result.value.secrets).toEqual({});
    }
    expect(eventStore.all()).toHaveLength(0);
  });

  it("returns a success result carrying the narrowed payload and the full secrets map", async () => {
    const { contextStore, eventStore, resolver } = buildResolver();
    await contextStore.save(
      new Context("greeting", { hello: "world" }, { TOKEN: "abc", OTHER: "def" }),
    );

    const result = await resolver.resolve({ kind: "producer", id: "p-1" }, "greeting", isShape);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.context).toEqual({ hello: "world" });
      expect(result.value.secrets).toEqual({ TOKEN: "abc", OTHER: "def" });
    }
    expect(eventStore.all()).toHaveLength(0);
  });

  it("returns a NOT_FOUND failure and emits a muted error.context event for a missing name", async () => {
    const { eventStore, resolver } = buildResolver();

    const result = await resolver.resolve({ kind: "producer", id: "p-1" }, "missing", isShape);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.name).toBe("missing");
      expect(result.error.reason).toBe("NOT_FOUND");
    }
    const events = eventStore.all();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe(ERROR_CONTEXT);
    expect(events[0].producerId).toBe(CONCORD_PRODUCER_ID);
    expect(events[0].muted).toBe(true);
    expect(events[0].payload).toEqual({
      requesterKind: "producer",
      requesterId: "p-1",
      contextName: "missing",
      reason: "NOT_FOUND",
    });
  });

  it("returns an INVALID_SHAPE failure and emits the corresponding event when the guard rejects the payload", async () => {
    const { contextStore, eventStore, resolver } = buildResolver();
    await contextStore.save(new Context("greeting", { goodbye: "world" }, { TOKEN: "abc" }));

    const result = await resolver.resolve({ kind: "consumer", id: "c-1" }, "greeting", isShape);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe("INVALID_SHAPE");
    }
    const events = eventStore.all();
    expect(events).toHaveLength(1);
    expect(events[0].payload).toEqual({
      requesterKind: "consumer",
      requesterId: "c-1",
      contextName: "greeting",
      reason: "INVALID_SHAPE",
    });
  });

  it("records the consumer requester kind in the emitted event payload", async () => {
    const { eventStore, resolver } = buildResolver();

    await resolver.resolve({ kind: "consumer", id: "c-9" }, "absent", isShape);

    const payload = eventStore.all()[0].payload as { requesterKind: string; requesterId: string };
    expect(payload.requesterKind).toBe("consumer");
    expect(payload.requesterId).toBe("c-9");
  });
});

describe("context CRUD use cases", () => {
  function build() {
    const store = new InMemoryContextStore();
    return {
      store,
      create: new CreateContextInteractor(store),
      update: new UpdateContextInteractor(store),
      delete: new DeleteContextInteractor(store),
      list: new ListContextsInteractor(store),
    };
  }

  it("create round-trips through list", async () => {
    const { create, list } = build();
    const descriptor = await create.create("greeting", { hello: "world" }, {});
    expect(descriptor).toEqual({ name: "greeting", payload: { hello: "world" }, secrets: {} });

    const result = await list.list({ limit: 50, offset: 0 });
    expect(result.total).toBe(1);
    expect(result.items).toEqual([{ name: "greeting", payload: { hello: "world" }, secrets: {} }]);
  });

  it("create round-trips secrets through list", async () => {
    const { create, list } = build();
    const descriptor = await create.create("greeting", { hello: "world" }, { TOKEN: "abc" });
    expect(descriptor.secrets).toEqual({ TOKEN: "abc" });

    const result = await list.list({ limit: 50, offset: 0 });
    expect(result.items[0].secrets).toEqual({ TOKEN: "abc" });
  });

  it("throws ContextAlreadyExistsError on a duplicate create", async () => {
    const { create } = build();
    await create.create("greeting", { hello: "world" }, {});
    await expect(create.create("greeting", { hello: "again" }, {})).rejects.toBeInstanceOf(ContextAlreadyExistsError);
  });

  it("update changes the payload and is reflected by list", async () => {
    const { create, update, list } = build();
    await create.create("greeting", { hello: "world" }, {});

    const updated = await update.update("greeting", { hello: "updated" }, { upserts: [], deletes: [] });
    expect(updated.payload).toEqual({ hello: "updated" });

    const result = await list.list({ limit: 50, offset: 0 });
    expect(result.items[0].payload).toEqual({ hello: "updated" });
  });

  it("update with an upsert-only operation adds a new secret and overwrites an existing one", async () => {
    const { create, update } = build();
    await create.create("greeting", { hello: "world" }, { TOKEN: "abc", OTHER: "def" });

    const updated = await update.update("greeting", { hello: "world" }, {
      upserts: [
        { name: "TOKEN", value: "new" },
        { name: "EXTRA", value: "added" },
      ],
      deletes: [],
    });
    expect(updated.secrets).toEqual({ TOKEN: "new", OTHER: "def", EXTRA: "added" });
  });

  it("update with a delete-only operation removes the named secret and is a silent no-op for a missing name", async () => {
    const { create, update } = build();
    await create.create("greeting", { hello: "world" }, { TOKEN: "abc", OTHER: "def" });

    const updated = await update.update("greeting", { hello: "world" }, {
      upserts: [],
      deletes: ["TOKEN", "GHOST"],
    });
    expect(updated.secrets).toEqual({ OTHER: "def" });
  });

  it("update with a mixed upsert-and-delete operation applies both", async () => {
    const { create, update } = build();
    await create.create("greeting", { hello: "world" }, { TOKEN: "abc", OTHER: "def" });

    const updated = await update.update("greeting", { hello: "world" }, {
      upserts: [{ name: "NEW", value: "added" }],
      deletes: ["TOKEN"],
    });
    expect(updated.secrets).toEqual({ OTHER: "def", NEW: "added" });
  });

  it("update preserves secrets whose names appear in neither upserts nor deletes", async () => {
    const { create, update } = build();
    await create.create("greeting", { hello: "world" }, { TOKEN: "abc", OTHER: "def", UNTOUCHED: "x" });

    const updated = await update.update("greeting", { hello: "world" }, {
      upserts: [{ name: "TOKEN", value: "new" }],
      deletes: ["OTHER"],
    });
    expect(updated.secrets).toEqual({ TOKEN: "new", UNTOUCHED: "x" });
  });

  it("throws ContextNotFoundError when updating a missing name", async () => {
    const { update } = build();
    await expect(
      update.update("missing", { hello: "world" }, { upserts: [], deletes: [] }),
    ).rejects.toBeInstanceOf(ContextNotFoundError);
  });

  it("delete removes the context and is reflected by list", async () => {
    const { create, delete: del, list } = build();
    await create.create("greeting", { hello: "world" }, {});

    await del.delete("greeting");

    const result = await list.list({ limit: 50, offset: 0 });
    expect(result.total).toBe(0);
  });

  it("throws ContextNotFoundError when deleting a missing name", async () => {
    const { delete: del } = build();
    await expect(del.delete("missing")).rejects.toBeInstanceOf(ContextNotFoundError);
  });
});
