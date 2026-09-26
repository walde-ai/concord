import { describe, it, expect, afterEach } from "vitest";
import { WebSocket } from "ws";
import { Event } from "../src/domain/entities/event";
import { Run, RunFailure } from "../src/domain/entities/run";
import { Context } from "../src/domain/entities/context";
import { failure } from "../src/domain/result";
import type { Producer } from "../src/domain/ports/in/producer";
import type { EventSink } from "../src/domain/ports/in/event-sink";
import type { Registration } from "../src/domain/ports/in/registration";
import { MakeApp } from "../src/infra/main/make-app";
import { HttpApiServer } from "../src/infra/adapters/api/http-api-server";
import { StreamBroadcaster } from "../src/infra/adapters/api/stream-broadcaster";
import { InMemoryEventStore } from "../src/infra/adapters/stores/in-memory-event-store";
import { InMemoryRunRepository } from "../src/infra/adapters/stores/in-memory-run-repository";
import { InMemoryProducerStateRepository } from "../src/infra/adapters/stores/in-memory-producer-state-repository";
import { InMemoryConsumerStateRepository } from "../src/infra/adapters/stores/in-memory-consumer-state-repository";
import { InMemoryPauseStateRepository } from "../src/infra/adapters/stores/in-memory-pause-state-repository";
import { InMemoryConsumerRegistry } from "../src/infra/adapters/registry/in-memory-consumer-registry";
import { InMemoryProducerRegistry } from "../src/infra/adapters/registry/in-memory-producer-registry";
import { InMemoryRunAbortRegistry } from "../src/infra/adapters/registry/in-memory-run-abort-registry";
import { ListProducersInteractor } from "../src/domain/interactors/list-producers-interactor";
import { ListConsumersInteractor } from "../src/domain/interactors/list-consumers-interactor";
import { ConsumerDescriptorBuilder } from "../src/domain/interactors/consumer-descriptor-builder";
import { InMemoryConsumerConfigRepository } from "../src/infra/adapters/stores/in-memory-consumer-config-repository";
import { MergingConsumerConfigResolver } from "../src/infra/adapters/config/merging-consumer-config-resolver";
import { RepositoryConsumerSecretResolver } from "../src/infra/adapters/config/repository-consumer-secret-resolver";
import { SetProducerEnabledInteractor } from "../src/domain/interactors/set-producer-enabled-interactor";
import { SetConsumerEnabledInteractor } from "../src/domain/interactors/set-consumer-enabled-interactor";
import { GetPauseStateInteractor } from "../src/domain/interactors/get-pause-state-interactor";
import { SetPauseStateInteractor } from "../src/domain/interactors/set-pause-state-interactor";
import { ReplayEventInteractor } from "../src/domain/interactors/replay-event-interactor";
import { AbortRunInteractor } from "../src/domain/interactors/abort-run-interactor";
import { RestartRunInteractor } from "../src/domain/interactors/restart-run-interactor";
import { SignalEventInteractor } from "../src/domain/interactors/signal-event-interactor";
import { RunDispatcher } from "../src/domain/interactors/run-dispatcher";
import { ConsumerRegistrable } from "../src/infra/adapters/consumers/consumer-registrable";
import { Consumer } from "../src/domain/entities/consumer";
import { InMemoryWidgetRegistry } from "../src/infra/adapters/widgets/widget-registry";
import type { Widget, WidgetPayload, WidgetRefresh } from "../src/infra/adapters/widgets/widget";
import { CreateContextInteractor } from "../src/domain/interactors/create-context-interactor";
import { UpdateContextInteractor } from "../src/domain/interactors/update-context-interactor";
import { DeleteContextInteractor } from "../src/domain/interactors/delete-context-interactor";
import { ListContextsInteractor } from "../src/domain/interactors/list-contexts-interactor";
import { InMemoryContextStore } from "../src/infra/adapters/stores/in-memory-context-store";
import { InMemoryCredentialStore } from "../src/infra/adapters/stores/in-memory-credential-store";
import { Credential } from "../src/domain/entities/credential";
import {
  Argon2PasswordSecretDeriver,
  SecureRemotePasswordIssuer,
  TEST_ARGON2ID_PARAMETERS,
} from "../src";
import type { App } from "../src/infra/main/app";
import { buildLoginSession, signHeaders } from "./auth-helpers";
import type { LoginSession } from "./auth-helpers";
import {
  FixedClock,
  HangingHandler,
  RecordingHandler,
  SequentialIdGenerator,
  TypeRule,
  buildDispatcher,
  successfulOutcome,
  waitFor,
} from "./helpers";

interface ApiResponse<T> {
  readonly status: number;
  readonly body: T;
}

async function apiRequest<T>(baseUrl: string, path: string): Promise<ApiResponse<T>> {
  const response = await fetch(`${baseUrl}${path}`, { method: "GET" });
  const body = (await response.json()) as T;
  return { status: response.status, body };
}

async function patchRequest<T>(
  baseUrl: string,
  path: string,
  payload: unknown,
): Promise<ApiResponse<T>> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = (await response.json()) as T;
  return { status: response.status, body };
}

async function requestWithBody<T>(
  baseUrl: string,
  method: string,
  path: string,
  payload?: unknown,
  rawBody?: string,
): Promise<ApiResponse<T>> {
  const init: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (rawBody !== undefined) {
    init.body = rawBody;
  } else if (payload !== undefined) {
    init.body = JSON.stringify(payload);
  }
  const response = await fetch(`${baseUrl}${path}`, init);
  const body = (await response.json()) as T;
  return { status: response.status, body };
}

async function emptyBodyRequest<T>(
  baseUrl: string,
  method: string,
  path: string,
): Promise<ApiResponse<T>> {
  const response = await fetch(`${baseUrl}${path}`, { method });
  const body = (await response.json()) as T;
  return { status: response.status, body };
}

class OnDemandProducer implements Producer {
  private sink: EventSink | null = null;

  public constructor(public readonly producerId: string) {}

  public register(registration: Registration): void {
    registration.addProducer(this);
  }

  public async start(sink: EventSink): Promise<void> {
    this.sink = sink;
  }

  public async stop(): Promise<void> {}

  public async emit(event: Event<unknown>): Promise<void> {
    if (this.sink === null) {
      throw new Error("OnDemandProducer has not been started");
    }
    await this.sink.emit(event);
  }
}

interface FakeWidgetPayload extends WidgetPayload {
  readonly kind: "fake";
  readonly message: string;
}

class FakeWidget implements Widget<FakeWidgetPayload> {
  public constructor(
    public readonly id: string,
    public readonly kind: string,
    public readonly refresh: WidgetRefresh,
    private readonly payload: FakeWidgetPayload,
  ) {}

  public async render(): Promise<FakeWidgetPayload> {
    return this.payload;
  }
}

function resolveApiBaseUrl(app: App): string {
  const internal = app as unknown as {
    startables: Array<{ address: { host: string; port: number } | null }>;
  };
  for (const service of internal.startables) {
    if (service.address !== null && service.address !== undefined) {
      return `${service.address.host}:${service.address.port}`;
    }
  }
  throw new Error("No started API server found on App");
}

function openStreamClient(url: string): Promise<WebSocket> {
  return new Promise<WebSocket>((resolve, reject) => {
    const client = new WebSocket(url);
    client.once("open", () => resolve(client));
    client.once("error", reject);
  });
}

async function seedCredential(store: InMemoryCredentialStore, username: string, password: string): Promise<void> {
  const deriver = new Argon2PasswordSecretDeriver(TEST_ARGON2ID_PARAMETERS);
  const issuer = new SecureRemotePasswordIssuer(deriver);
  const issued = await issuer.generate(username, password);
  await store.save(new Credential(username, issued.salt, issued.verifier));
}

async function openAuthenticatedStream(
  baseUrl: string,
  store: InMemoryCredentialStore,
  username: string,
  password: string,
): Promise<WebSocket> {
  await seedCredential(store, username, password);
  const session = await buildLoginSession(baseUrl, username, password);
  const headers = signHeaders(session, "GET", "/api/stream", "");
  const params = new URLSearchParams({
    session: session.sessionId,
    timestamp: headers["X-Concord-Timestamp"],
    nonce: headers["X-Concord-Nonce"],
    signature: headers["X-Concord-Signature"],
  });
  return openStreamClient(`ws://${baseUrl}/api/stream?${params.toString()}`);
}

describe("HTTP API — listing contract", () => {
  let server: HttpApiServer | null = null;

  afterEach(async () => {
    if (server !== null) {
      await server.close();
      server = null;
    }
  });

  function boot(eventStore: InMemoryEventStore, runRepository: InMemoryRunRepository): Promise<string> {
    const broadcaster = new StreamBroadcaster();
    server = new HttpApiServer("127.0.0.1", 0, eventStore, runRepository, broadcaster);
    return server.start().then(() => `http://127.0.0.1:${server!.address!.port}`);
  }

  it("returns events most-recent-first with correct totals and pagination", async () => {
    const eventStore = new InMemoryEventStore();
    const runRepository = new InMemoryRunRepository();

    const events = [
      new Event<unknown>("evt-1", "p-1", "pevt-1", new Date("2026-07-01T00:00:00Z"), "foo", { n: 1 }),
      new Event<unknown>("evt-2", "p-1", "pevt-2", new Date("2026-07-03T00:00:00Z"), "foo", { n: 2 }),
      new Event<unknown>("evt-3", "p-1", "pevt-3", new Date("2026-07-02T00:00:00Z"), "foo", { n: 3 }),
    ];
    for (const event of events) {
      await eventStore.save(event);
    }

    const baseUrl = await boot(eventStore, runRepository);

    const firstPage = await apiRequest<{
      ok: boolean;
      data: { items: { id: string }[]; total: number; limit: number; offset: number };
    }>(baseUrl, "/api/events?limit=2&offset=0");

    expect(firstPage.status).toBe(200);
    expect(firstPage.body.ok).toBe(true);
    expect(firstPage.body.data.items).toHaveLength(2);
    expect(firstPage.body.data.total).toBe(3);
    expect(firstPage.body.data.items.map((item) => item.id)).toEqual(["evt-2", "evt-3"]);

    const secondPage = await apiRequest<{
      ok: boolean;
      data: { items: { id: string }[] };
    }>(baseUrl, "/api/events?limit=2&offset=2");

    expect(secondPage.body.data.items.map((item) => item.id)).toEqual(["evt-1"]);
  });

  it("returns the default page when no query string is provided", async () => {
    const eventStore = new InMemoryEventStore();
    const runRepository = new InMemoryRunRepository();

    await eventStore.save(new Event<unknown>("evt-1", "p-1", "pevt-1", new Date("2026-07-01T00:00:00Z"), "foo", {}));

    const baseUrl = await boot(eventStore, runRepository);

    const result = await apiRequest<{
      ok: boolean;
      data: { limit: number; offset: number; items: unknown[] };
    }>(baseUrl, "/api/events");

    expect(result.body.data.limit).toBe(50);
    expect(result.body.data.offset).toBe(0);
  });

  it("returns BAD_REQUEST for a non-numeric limit", async () => {
    const eventStore = new InMemoryEventStore();
    const runRepository = new InMemoryRunRepository();

    const baseUrl = await boot(eventStore, runRepository);

    const result = await apiRequest<{
      ok: boolean;
      error: { code: string };
    }>(baseUrl, "/api/events?limit=abc");

    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe("BAD_REQUEST");
  });
});

describe("HTTP API — single-resource reads", () => {
  let server: HttpApiServer | null = null;

  afterEach(async () => {
    if (server !== null) {
      await server.close();
      server = null;
    }
  });

  function boot(eventStore: InMemoryEventStore, runRepository: InMemoryRunRepository): Promise<string> {
    const broadcaster = new StreamBroadcaster();
    server = new HttpApiServer("127.0.0.1", 0, eventStore, runRepository, broadcaster);
    return server.start().then(() => `http://127.0.0.1:${server!.address!.port}`);
  }

  it("returns a single event by id", async () => {
    const eventStore = new InMemoryEventStore();
    const runRepository = new InMemoryRunRepository();

    await eventStore.save(
      new Event<unknown>("evt-1", "p-1", "pevt-1", new Date("2026-07-04T00:00:00Z"), "foo", { n: 1 }),
    );

    const baseUrl = await boot(eventStore, runRepository);

    const result = await apiRequest<{
      ok: boolean;
      data: { id: string; producerId: string; datetime: string; type: string; payload: { n: number } };
    }>(baseUrl, "/api/events/evt-1");

    expect(result.status).toBe(200);
    expect(result.body.data.id).toBe("evt-1");
    expect(result.body.data.datetime).toBe("2026-07-04T00:00:00.000Z");
    expect(result.body.data.payload).toEqual({ n: 1 });
  });

  it("returns NOT_FOUND for an unknown event id", async () => {
    const eventStore = new InMemoryEventStore();
    const runRepository = new InMemoryRunRepository();

    const baseUrl = await boot(eventStore, runRepository);

    const result = await apiRequest<{ ok: boolean; error: { code: string } }>(baseUrl, "/api/events/missing");

    expect(result.status).toBe(404);
    expect(result.body.error.code).toBe("NOT_FOUND");
  });

  it("returns NOT_FOUND for an unknown run id", async () => {
    const eventStore = new InMemoryEventStore();
    const runRepository = new InMemoryRunRepository();

    const baseUrl = await boot(eventStore, runRepository);

    const result = await apiRequest<{ ok: boolean; error: { code: string } }>(baseUrl, "/api/runs/missing");

    expect(result.status).toBe(404);
    expect(result.body.error.code).toBe("NOT_FOUND");
  });

  it("returns NOT_FOUND envelope for an unmatched route", async () => {
    const eventStore = new InMemoryEventStore();
    const runRepository = new InMemoryRunRepository();

    const baseUrl = await boot(eventStore, runRepository);

    const result = await apiRequest<{ ok: boolean; error: { code: string } }>(baseUrl, "/api/unknown");

    expect(result.status).toBe(404);
    expect(result.body.error.code).toBe("NOT_FOUND");
  });
});

describe("HTTP API — runs endpoints", () => {
  let server: HttpApiServer | null = null;

  afterEach(async () => {
    if (server !== null) {
      await server.close();
      server = null;
    }
  });

  function boot(eventStore: InMemoryEventStore, runRepository: InMemoryRunRepository): Promise<string> {
    const broadcaster = new StreamBroadcaster();
    server = new HttpApiServer("127.0.0.1", 0, eventStore, runRepository, broadcaster);
    return server.start().then(() => `http://127.0.0.1:${server!.address!.port}`);
  }

  it("returns paginated runs with embedded events", async () => {
    const eventStore = new InMemoryEventStore();
    const runRepository = new InMemoryRunRepository();

    const event = new Event<unknown>("evt-1", "p-1", "pevt-1", new Date("2026-07-04T00:00:00Z"), "foo", { x: 1 });
    await eventStore.save(event);
    await runRepository.save(new Run("run-1", event, "c-1", "SUCCEEDED"));
    await runRepository.save(new Run("run-2", event, "c-1", "FAILED"));

    const baseUrl = await boot(eventStore, runRepository);

    const result = await apiRequest<{
      ok: boolean;
      data: {
        items: { id: string; consumerId: string; state: string; event: { id: string } }[];
        total: number;
      };
    }>(baseUrl, "/api/runs");

    expect(result.status).toBe(200);
    expect(result.body.data.total).toBe(2);
    expect(result.body.data.items.map((item) => item.id)).toEqual(["run-2", "run-1"]);
    expect(result.body.data.items[0].event.id).toBe("evt-1");
    expect(result.body.data.items[0].consumerId).toBe("c-1");
  });

  it("exposes the failure debug info for a failed run on the detail endpoint", async () => {
    const eventStore = new InMemoryEventStore();
    const runRepository = new InMemoryRunRepository();

    const event = new Event<unknown>("evt-1", "p-1", "pevt-1", new Date("2026-07-04T00:00:00Z"), "foo", { x: 1 });
    await eventStore.save(event);
    const failure = new RunFailure("EventHandlerError", "boom", "stack-line");
    await runRepository.save(new Run("run-failed", event, "c-1", "FAILED", failure));

    const baseUrl = await boot(eventStore, runRepository);

    const result = await apiRequest<{
      ok: boolean;
      data: {
        id: string;
        state: string;
        failure: { errorName: string; message: string; stack: string | null } | null;
      };
    }>(baseUrl, "/api/runs/run-failed");

    expect(result.status).toBe(200);
    expect(result.body.data.state).toBe("FAILED");
    expect(result.body.data.failure).not.toBeNull();
    expect(result.body.data.failure?.errorName).toBe("EventHandlerError");
    expect(result.body.data.failure?.message).toBe("boom");
    expect(result.body.data.failure?.stack).toBe("stack-line");
  });

  it("returns runs for a specific event and NOT_FOUND for an unknown event", async () => {
    const eventStore = new InMemoryEventStore();
    const runRepository = new InMemoryRunRepository();

    const event = new Event<unknown>("evt-1", "p-1", "pevt-1", new Date("2026-07-04T00:00:00Z"), "foo", {});
    await eventStore.save(event);
    await runRepository.save(new Run("run-1", event, "c-1", "SUCCEEDED"));

    const baseUrl = await boot(eventStore, runRepository);

    const knownResult = await apiRequest<{
      ok: boolean;
      data: { items: { id: string; consumerId: string }[]; total: number };
    }>(baseUrl, "/api/events/evt-1/runs");

    expect(knownResult.body.data.total).toBe(1);
    expect(knownResult.body.data.items[0].id).toBe("run-1");
    expect(knownResult.body.data.items[0].consumerId).toBe("c-1");

    const unknownResult = await apiRequest<{
      ok: boolean;
      error: { code: string };
    }>(baseUrl, "/api/events/missing/runs");

    expect(unknownResult.status).toBe(404);
    expect(unknownResult.body.error.code).toBe("NOT_FOUND");
  });
});

describe("WebSocket streaming — lifecycle frames", () => {
  let app: App | null = null;

  afterEach(async () => {
    if (app !== null) {
      await app.stop();
      app = null;
    }
  });

  it("pushes event.created, run.created, and run.state_changed frames in order", async () => {
    const handler = new RecordingHandler(successfulOutcome());
    const producer = new OnDemandProducer("p-1");
    const credentialStore = new InMemoryCredentialStore();

    app = MakeApp({
      idGenerator: new SequentialIdGenerator(),
      eventStore: new InMemoryEventStore(),
      runRepository: new InMemoryRunRepository(),
      credentialStore,
      api: { host: "127.0.0.1", port: 0 },
      auth: {
        argon2: TEST_ARGON2ID_PARAMETERS,
        handshakeTtlMs: 30_000,
        sessionLifetimeMs: 3_600_000,
        freshnessWindowMs: 5 * 60 * 1000,
        pepper: "integration-pepper",
      },
    });
    app.register(new ConsumerRegistrable(new Consumer<unknown>("c-1", new TypeRule("foo"), handler, [], [])));
    app.register(producer);

    await app.start();

    const baseUrl = resolveApiBaseUrl(app);
    const client = await openAuthenticatedStream(baseUrl, credentialStore, "alice", "secret");

    const frames: { type: string; data: unknown }[] = [];
    client.on("message", (raw: { toString: () => string }) => {
      frames.push(JSON.parse(raw.toString()));
    });

    const event = new Event<unknown>("evt-1", "p-1", "pevt-1", new Date("2026-07-04T00:00:00Z"), "foo", { n: 1 });
    await producer.emit(event);

    await waitFor(() => (frames.length >= 4 ? frames : undefined));

    expect(frames[0].type).toBe("event.created");
    expect((frames[0].data as { id: string }).id).toBe("evt-1");

    expect(frames[1].type).toBe("run.created");
    expect((frames[1].data as { state: string }).state).toBe("NOT_STARTED");

    expect(frames[2].type).toBe("run.state_changed");
    expect((frames[2].data as { state: string }).state).toBe("RUNNING");

    expect(frames[3].type).toBe("run.state_changed");
    expect((frames[3].data as { state: string }).state).toBe("SUCCEEDED");

    client.close();
  });

  it("pushes FAILED terminal state for a failing handler", async () => {
    const handler = new RecordingHandler(failure<void, Error>(new Error("boom")));
    const producer = new OnDemandProducer("p-1");
    const credentialStore = new InMemoryCredentialStore();

    app = MakeApp({
      idGenerator: new SequentialIdGenerator(),
      eventStore: new InMemoryEventStore(),
      runRepository: new InMemoryRunRepository(),
      credentialStore,
      api: { host: "127.0.0.1", port: 0 },
      auth: {
        argon2: TEST_ARGON2ID_PARAMETERS,
        handshakeTtlMs: 30_000,
        sessionLifetimeMs: 3_600_000,
        freshnessWindowMs: 5 * 60 * 1000,
        pepper: "integration-pepper",
      },
    });
    app.register(new ConsumerRegistrable(new Consumer<unknown>("c-1", new TypeRule("foo"), handler, [], [])));
    app.register(producer);

    await app.start();

    const baseUrl = resolveApiBaseUrl(app);
    const client = await openAuthenticatedStream(baseUrl, credentialStore, "alice", "secret");

    const frames: { type: string; data: unknown }[] = [];
    client.on("message", (raw: { toString: () => string }) => {
      frames.push(JSON.parse(raw.toString()));
    });

    const event = new Event<unknown>("evt-1", "p-1", "pevt-1", new Date("2026-07-04T00:00:00Z"), "foo", {});
    await producer.emit(event);

    await waitFor(() => (frames.length >= 4 ? frames : undefined));

    const stateChanges = frames.filter((frame) => frame.type === "run.state_changed");
    const terminal = stateChanges[stateChanges.length - 1];
    expect((terminal.data as { state: string }).state).toBe("FAILED");

    client.close();
  });
});

describe("HTTP API — producers and consumers management", () => {
  let server: HttpApiServer | null = null;

  afterEach(async () => {
    if (server !== null) {
      await server.close();
      server = null;
    }
  });

  function boot(
    producerRegistry: InMemoryProducerRegistry,
    consumerRegistry: InMemoryConsumerRegistry,
    producerStates: InMemoryProducerStateRepository,
    consumerStates: InMemoryConsumerStateRepository,
  ): Promise<string> {
    const eventStore = new InMemoryEventStore();
    const runRepository = new InMemoryRunRepository();
    const broadcaster = new StreamBroadcaster();
    const configRepository = new InMemoryConsumerConfigRepository();
    const configResolver = new MergingConsumerConfigResolver(consumerRegistry, configRepository);
    const descriptorBuilder = new ConsumerDescriptorBuilder(consumerRegistry, consumerStates, configResolver, new RepositoryConsumerSecretResolver(consumerRegistry, configRepository));
    const listProducers = new ListProducersInteractor(producerRegistry, producerStates);
    const listConsumers = new ListConsumersInteractor(consumerRegistry, descriptorBuilder);
    const setProducerEnabled = new SetProducerEnabledInteractor(producerRegistry, producerStates);
    const setConsumerEnabled = new SetConsumerEnabledInteractor(consumerRegistry, consumerStates);
    server = new HttpApiServer(
      "127.0.0.1",
      0,
      eventStore,
      runRepository,
      broadcaster,
      listProducers,
      listConsumers,
      setProducerEnabled,
      setConsumerEnabled,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    );
    return server.start().then(() => `http://127.0.0.1:${server!.address!.port}`);
  }

  it("lists registered producers and consumers with their enabled state", async () => {
    const producerRegistry = new InMemoryProducerRegistry();
    const consumerRegistry = new InMemoryConsumerRegistry();
    const producerStates = new InMemoryProducerStateRepository();
    const consumerStates = new InMemoryConsumerStateRepository();

    producerRegistry.register({ producerId: "p-1", disableable: true });
    consumerRegistry.register(new Consumer<unknown>("c-1", new TypeRule("foo"), new RecordingHandler(successfulOutcome()), [], []));

    const baseUrl = await boot(producerRegistry, consumerRegistry, producerStates, consumerStates);

    const producers = await apiRequest<{ ok: boolean; data: { id: string; enabled: boolean }[] }>(
      baseUrl,
      "/api/producers",
    );
    expect(producers.status).toBe(200);
    expect(producers.body.data).toEqual([{ id: "p-1", enabled: true, disableable: true }]);

    const consumers = await apiRequest<{ ok: boolean; data: { id: string; enabled: boolean; waitForOffPeak: boolean; configParameters: unknown[]; configValues: Record<string, string> }[] }>(
      baseUrl,
      "/api/consumers",
    );
    expect(consumers.body.data).toEqual([{ id: "c-1", enabled: true, waitForOffPeak: false, configParameters: [], configValues: {}, secretParameters: [], secretNames: [] }]);
  });

  it("applies a producer PATCH and reflects the change on a subsequent GET", async () => {
    const producerRegistry = new InMemoryProducerRegistry();
    const consumerRegistry = new InMemoryConsumerRegistry();
    const producerStates = new InMemoryProducerStateRepository();
    const consumerStates = new InMemoryConsumerStateRepository();

    producerRegistry.register({ producerId: "p-1", disableable: true });

    const baseUrl = await boot(producerRegistry, consumerRegistry, producerStates, consumerStates);

    const patched = await patchRequest<{ ok: boolean; data: { id: string; enabled: boolean } }>(
      baseUrl,
      "/api/producers/p-1",
      { enabled: false },
    );
    expect(patched.status).toBe(200);
    expect(patched.body.data).toEqual({ id: "p-1", enabled: false });

    const after = await apiRequest<{ ok: boolean; data: { id: string; enabled: boolean }[] }>(
      baseUrl,
      "/api/producers",
    );
    expect(after.body.data[0].enabled).toBe(false);
  });

  it("applies a consumer PATCH and reflects the change on a subsequent GET", async () => {
    const producerRegistry = new InMemoryProducerRegistry();
    const consumerRegistry = new InMemoryConsumerRegistry();
    const producerStates = new InMemoryProducerStateRepository();
    const consumerStates = new InMemoryConsumerStateRepository();

    consumerRegistry.register(new Consumer<unknown>("c-1", new TypeRule("foo"), new RecordingHandler(successfulOutcome()), [], []));

    const baseUrl = await boot(producerRegistry, consumerRegistry, producerStates, consumerStates);

    const patched = await patchRequest<{ ok: boolean; data: { id: string; enabled: boolean } }>(
      baseUrl,
      "/api/consumers/c-1",
      { enabled: false },
    );
    expect(patched.body.data).toEqual({ id: "c-1", enabled: false });
  });

  it("returns FORBIDDEN for a PATCH on a non-disableable producer", async () => {
    const producerRegistry = new InMemoryProducerRegistry();
    const consumerRegistry = new InMemoryConsumerRegistry();
    const producerStates = new InMemoryProducerStateRepository();
    const consumerStates = new InMemoryConsumerStateRepository();

    producerRegistry.register({ producerId: "web-ui", disableable: false });

    const baseUrl = await boot(producerRegistry, consumerRegistry, producerStates, consumerStates);

    const result = await patchRequest<{ ok: boolean; error: { code: string } }>(
      baseUrl,
      "/api/producers/web-ui",
      { enabled: false },
    );
    expect(result.status).toBe(403);
    expect(result.body.error.code).toBe("FORBIDDEN");
  });

  it("returns NOT_FOUND for a PATCH to an unregistered producer id", async () => {
    const producerRegistry = new InMemoryProducerRegistry();
    const consumerRegistry = new InMemoryConsumerRegistry();
    const producerStates = new InMemoryProducerStateRepository();
    const consumerStates = new InMemoryConsumerStateRepository();

    const baseUrl = await boot(producerRegistry, consumerRegistry, producerStates, consumerStates);

    const result = await patchRequest<{ ok: boolean; error: { code: string } }>(
      baseUrl,
      "/api/producers/ghost",
      { enabled: false },
    );
    expect(result.status).toBe(404);
    expect(result.body.error.code).toBe("NOT_FOUND");
  });

  it("returns BAD_REQUEST for a PATCH missing a boolean enabled field", async () => {
    const producerRegistry = new InMemoryProducerRegistry();
    const consumerRegistry = new InMemoryConsumerRegistry();
    const producerStates = new InMemoryProducerStateRepository();
    const consumerStates = new InMemoryConsumerStateRepository();

    producerRegistry.register({ producerId: "p-1", disableable: true });

    const baseUrl = await boot(producerRegistry, consumerRegistry, producerStates, consumerStates);

    const missing = await patchRequest<{ ok: boolean; error: { code: string } }>(
      baseUrl,
      "/api/producers/p-1",
      {},
    );
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe("BAD_REQUEST");

    const nonBoolean = await patchRequest<{ ok: boolean; error: { code: string } }>(
      baseUrl,
      "/api/producers/p-1",
      { enabled: "yes" },
    );
    expect(nonBoolean.status).toBe(400);
    expect(nonBoolean.body.error.code).toBe("BAD_REQUEST");
  });
});

describe("HTTP API — contexts CRUD", () => {
  let server: HttpApiServer | null = null;

  afterEach(async () => {
    if (server !== null) {
      await server.close();
      server = null;
    }
  });

  function boot(contextStore: InMemoryContextStore): Promise<string> {
    const eventStore = new InMemoryEventStore();
    const runRepository = new InMemoryRunRepository();
    const broadcaster = new StreamBroadcaster();
    const createContext = new CreateContextInteractor(contextStore);
    const updateContext = new UpdateContextInteractor(contextStore);
    const deleteContext = new DeleteContextInteractor(contextStore);
    const listContexts = new ListContextsInteractor(contextStore);
    server = new HttpApiServer(
      "127.0.0.1",
      0,
      eventStore,
      runRepository,
      broadcaster,
      null,
      null,
      null,
      null,
      createContext,
      updateContext,
      deleteContext,
      listContexts,
    );
    return server.start().then(() => `http://127.0.0.1:${server!.address!.port}`);
  }

  it("lists paginated contexts ordered by name", async () => {
    const contextStore = new InMemoryContextStore();
    await contextStore.save(new Context("bravo", { n: 2 }, {}));
    await contextStore.save(new Context("alpha", { n: 1 }, {}));

    const baseUrl = await boot(contextStore);

    const result = await apiRequest<{
      ok: boolean;
      data: { items: { name: string }[]; total: number; limit: number; offset: number };
    }>(baseUrl, "/api/contexts?limit=1&offset=0");

    expect(result.status).toBe(200);
    expect(result.body.data.total).toBe(2);
    expect(result.body.data.items.map((item) => item.name)).toEqual(["alpha"]);
    expect(result.body.data.limit).toBe(1);
  });

  it("creates a context via POST and returns the DTO, and a duplicate returns CONFLICT", async () => {
    const contextStore = new InMemoryContextStore();
    const baseUrl = await boot(contextStore);

    const created = await requestWithBody<{
      ok: boolean;
      data: { name: string; payload: unknown; secretNames: string[] };
    }>(baseUrl, "POST", "/api/contexts", {
      name: "greeting",
      payload: { hello: "world" },
      secrets: [],
    });

    expect(created.status).toBe(200);
    expect(created.body.data).toEqual({ name: "greeting", payload: { hello: "world" }, secretNames: [] });

    const duplicate = await requestWithBody<{ ok: boolean; error: { code: string } }>(
      baseUrl,
      "POST",
      "/api/contexts",
      { name: "greeting", payload: { hello: "again" }, secrets: [] },
    );
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe("CONFLICT");
  });

  it("updates a context via PUT and returns the DTO, and an unknown name returns NOT_FOUND", async () => {
    const contextStore = new InMemoryContextStore();
    await contextStore.save(new Context("greeting", { hello: "world" }, {}));
    const baseUrl = await boot(contextStore);

    const updated = await requestWithBody<{
      ok: boolean;
      data: { name: string; payload: unknown; secretNames: string[] };
    }>(baseUrl, "PUT", "/api/contexts/greeting", {
      payload: { hello: "updated" },
      secrets: { upserts: [], deletes: [] },
    });

    expect(updated.status).toBe(200);
    expect(updated.body.data.payload).toEqual({ hello: "updated" });

    const missing = await requestWithBody<{ ok: boolean; error: { code: string } }>(
      baseUrl,
      "PUT",
      "/api/contexts/unknown",
      { payload: { hello: "x" }, secrets: { upserts: [], deletes: [] } },
    );
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("NOT_FOUND");
  });

  it("deletes a context via DELETE and returns { name }, and an unknown name returns NOT_FOUND", async () => {
    const contextStore = new InMemoryContextStore();
    await contextStore.save(new Context("greeting", { hello: "world" }, {}));
    const baseUrl = await boot(contextStore);

    const deleted = await emptyBodyRequest<{
      ok: boolean;
      data: { name: string };
    }>(baseUrl, "DELETE", "/api/contexts/greeting");

    expect(deleted.status).toBe(200);
    expect(deleted.body.data).toEqual({ name: "greeting" });

    const missing = await emptyBodyRequest<{ ok: boolean; error: { code: string } }>(
      baseUrl,
      "DELETE",
      "/api/contexts/greeting",
    );
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("NOT_FOUND");
  });

  it("returns BAD_REQUEST for a malformed POST body", async () => {
    const contextStore = new InMemoryContextStore();
    const baseUrl = await boot(contextStore);

    const nonJson = await requestWithBody<{ ok: boolean; error: { code: string } }>(
      baseUrl,
      "POST",
      "/api/contexts",
      undefined,
      "this is not json",
    );
    expect(nonJson.status).toBe(400);
    expect(nonJson.body.error.code).toBe("BAD_REQUEST");

    const missingName = await requestWithBody<{ ok: boolean; error: { code: string } }>(
      baseUrl,
      "POST",
      "/api/contexts",
      { payload: { hello: "world" } },
    );
    expect(missingName.status).toBe(400);
    expect(missingName.body.error.code).toBe("BAD_REQUEST");

    const nonObjectPayload = await requestWithBody<{ ok: boolean; error: { code: string } }>(
      baseUrl,
      "POST",
      "/api/contexts",
      { name: "greeting", payload: "not-an-object" },
    );
    expect(nonObjectPayload.status).toBe(400);
    expect(nonObjectPayload.body.error.code).toBe("BAD_REQUEST");
  });

  it("returns BAD_REQUEST for a malformed PUT body", async () => {
    const contextStore = new InMemoryContextStore();
    const baseUrl = await boot(contextStore);

    const missingPayload = await requestWithBody<{ ok: boolean; error: { code: string } }>(
      baseUrl,
      "PUT",
      "/api/contexts/greeting",
      {},
    );
    expect(missingPayload.status).toBe(400);
    expect(missingPayload.body.error.code).toBe("BAD_REQUEST");

    const arrayPayload = await requestWithBody<{ ok: boolean; error: { code: string } }>(
      baseUrl,
      "PUT",
      "/api/contexts/greeting",
      { payload: [1, 2, 3] },
    );
    expect(arrayPayload.status).toBe(400);
    expect(arrayPayload.body.error.code).toBe("BAD_REQUEST");
  });
});

describe("HTTP API — contexts secrets contract", () => {
  let server: HttpApiServer | null = null;

  afterEach(async () => {
    if (server !== null) {
      await server.close();
      server = null;
    }
  });

  function boot(contextStore: InMemoryContextStore): Promise<string> {
    const eventStore = new InMemoryEventStore();
    const runRepository = new InMemoryRunRepository();
    const broadcaster = new StreamBroadcaster();
    const createContext = new CreateContextInteractor(contextStore);
    const updateContext = new UpdateContextInteractor(contextStore);
    const deleteContext = new DeleteContextInteractor(contextStore);
    const listContexts = new ListContextsInteractor(contextStore);
    server = new HttpApiServer(
      "127.0.0.1",
      0,
      eventStore,
      runRepository,
      broadcaster,
      null,
      null,
      null,
      null,
      createContext,
      updateContext,
      deleteContext,
      listContexts,
    );
    return server.start().then(() => `http://127.0.0.1:${server!.address!.port}`);
  }

  it("GET /api/contexts returns secretNames and never secret values", async () => {
    const contextStore = new InMemoryContextStore();
    await contextStore.save(
      new Context("greeting", { hello: "world" }, { TOKEN: "secret-value", OTHER: "another-secret" }),
    );
    const baseUrl = await boot(contextStore);

    const result = await apiRequest<{
      ok: boolean;
      data: { items: { name: string; secretNames: string[] }[] };
    }>(baseUrl, "/api/contexts");

    expect(result.status).toBe(200);
    expect(result.body.data.items[0].secretNames).toEqual(["OTHER", "TOKEN"]);
    const bodyText = JSON.stringify(result.body);
    expect(bodyText).not.toContain("secret-value");
    expect(bodyText).not.toContain("another-secret");
  });

  it("POST with a secrets array creates the context and returns the secretNames", async () => {
    const contextStore = new InMemoryContextStore();
    const baseUrl = await boot(contextStore);

    const created = await requestWithBody<{
      ok: boolean;
      data: { name: string; secretNames: string[] };
    }>(baseUrl, "POST", "/api/contexts", {
      name: "greeting",
      payload: { hello: "world" },
      secrets: [
        { name: "TOKEN", value: "abc" },
        { name: "OTHER", value: "def" },
      ],
    });

    expect(created.status).toBe(200);
    expect(created.body.data.secretNames).toEqual(["OTHER", "TOKEN"]);
    const bodyText = JSON.stringify(created.body);
    expect(bodyText).not.toContain("\"abc\"");
    expect(bodyText).not.toContain("\"def\"");

    const stored = await contextStore.getByName("greeting");
    expect(stored.secrets).toEqual({ TOKEN: "abc", OTHER: "def" });
  });

  it("POST with a duplicate secret name returns BAD_REQUEST", async () => {
    const contextStore = new InMemoryContextStore();
    const baseUrl = await boot(contextStore);

    const result = await requestWithBody<{ ok: boolean; error: { code: string } }>(
      baseUrl,
      "POST",
      "/api/contexts",
      {
        name: "greeting",
        payload: { hello: "world" },
        secrets: [
          { name: "TOKEN", value: "abc" },
          { name: "TOKEN", value: "def" },
        ],
      },
    );

    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe("BAD_REQUEST");
  });

  it("POST with a non-array secrets field returns BAD_REQUEST", async () => {
    const contextStore = new InMemoryContextStore();
    const baseUrl = await boot(contextStore);

    const result = await requestWithBody<{ ok: boolean; error: { code: string } }>(
      baseUrl,
      "POST",
      "/api/contexts",
      { name: "greeting", payload: { hello: "world" }, secrets: { TOKEN: "abc" } },
    );

    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe("BAD_REQUEST");
  });

  it("POST with an entry with an empty name returns BAD_REQUEST", async () => {
    const contextStore = new InMemoryContextStore();
    const baseUrl = await boot(contextStore);

    const result = await requestWithBody<{ ok: boolean; error: { code: string } }>(
      baseUrl,
      "POST",
      "/api/contexts",
      {
        name: "greeting",
        payload: { hello: "world" },
        secrets: [{ name: "", value: "abc" }],
      },
    );

    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe("BAD_REQUEST");
  });

  it("PUT with an upserts-and-deletes body updates the secret set and returns the new secretNames", async () => {
    const contextStore = new InMemoryContextStore();
    await contextStore.save(new Context("greeting", { hello: "world" }, { TOKEN: "abc", OTHER: "def" }));
    const baseUrl = await boot(contextStore);

    const updated = await requestWithBody<{
      ok: boolean;
      data: { name: string; secretNames: string[] };
    }>(baseUrl, "PUT", "/api/contexts/greeting", {
      payload: { hello: "world" },
      secrets: {
        upserts: [{ name: "NEW", value: "added" }],
        deletes: ["TOKEN"],
      },
    });

    expect(updated.status).toBe(200);
    expect(updated.body.data.secretNames).toEqual(["NEW", "OTHER"]);
    const bodyText = JSON.stringify(updated.body);
    expect(bodyText).not.toContain("\"added\"");
    expect(bodyText).not.toContain("\"def\"");

    const stored = await contextStore.getByName("greeting");
    expect(stored.secrets).toEqual({ OTHER: "def", NEW: "added" });
  });

  it("PUT with a name present in both upserts and deletes returns BAD_REQUEST", async () => {
    const contextStore = new InMemoryContextStore();
    await contextStore.save(new Context("greeting", { hello: "world" }, {}));
    const baseUrl = await boot(contextStore);

    const result = await requestWithBody<{ ok: boolean; error: { code: string } }>(
      baseUrl,
      "PUT",
      "/api/contexts/greeting",
      {
        payload: { hello: "world" },
        secrets: {
          upserts: [{ name: "TOKEN", value: "abc" }],
          deletes: ["TOKEN"],
        },
      },
    );

    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe("BAD_REQUEST");
  });

  it("PUT with a non-array upserts field returns BAD_REQUEST", async () => {
    const contextStore = new InMemoryContextStore();
    await contextStore.save(new Context("greeting", { hello: "world" }, {}));
    const baseUrl = await boot(contextStore);

    const result = await requestWithBody<{ ok: boolean; error: { code: string } }>(
      baseUrl,
      "PUT",
      "/api/contexts/greeting",
      {
        payload: { hello: "world" },
        secrets: { upserts: "nope", deletes: [] },
      },
    );

    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe("BAD_REQUEST");
  });
});

describe("Contexts end-to-end through MakeApp", () => {
  let app: App | null = null;

  afterEach(async () => {
    if (app !== null) {
      await app.stop();
      app = null;
    }
  });

  it("registers the concord system producer and resolves contexts through a registered producer", async () => {
    const contextStore = new InMemoryContextStore();
    await contextStore.save(new Context("greeting", { hello: "world" }, {}));

    let resolver: Registration["contexts"] | null = null;
    let resolved: unknown = null;
    const producer: Producer = {
      producerId: "p-1",
      register(registration: Registration): void {
        resolver = registration.contexts;
        registration.addProducer(this);
      },
      async start(): Promise<void> {
        if (resolver === null) {
          throw new Error("resolver not captured");
        }
        const result = await resolver.resolve(
          { kind: "producer", id: "p-1" },
          "greeting",
          (value): value is { hello: string } =>
            typeof value === "object" && value !== null && !Array.isArray(value) && "hello" in value,
        );
        if (result.ok) {
          resolved = result.value.context;
        }
      },
      async stop(): Promise<void> {},
    };

    app = MakeApp({
      contextStore,
      idGenerator: new SequentialIdGenerator(),
      clock: new FixedClock(new Date("2026-07-04T00:00:00Z")),
    });
    app.register(producer);
    await app.start();

    expect(resolved).toEqual({ hello: "world" });
  });

  it("emits a muted error.context event when a producer resolves a missing context", async () => {
    const eventStore = new InMemoryEventStore();
    app = MakeApp({
      eventStore,
      idGenerator: new SequentialIdGenerator(),
      clock: new FixedClock(new Date("2026-07-04T00:00:00Z")),
    });

    let resolver: Registration["contexts"] | null = null;
    let failed = false;
    const producer: Producer = {
      producerId: "p-1",
      register(registration: Registration): void {
        resolver = registration.contexts;
        registration.addProducer(this);
      },
      async start(): Promise<void> {
        if (resolver === null) {
          throw new Error("resolver not captured");
        }
        const result = await resolver.resolve(
          { kind: "producer", id: "p-1" },
          "missing",
          (_value): _value is unknown => true,
        );
        failed = !result.ok;
      },
      async stop(): Promise<void> {},
    };
    app.register(producer);
    await app.start();

    expect(failed).toBe(true);
    const errorEvents = eventStore.all().filter((event) => event.type === "error.context");
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0].muted).toBe(true);
    expect(errorEvents[0].producerId).toBe("concord");
  });
});

describe("HTTP API — pause, replay, abort, restart", () => {
  let server: HttpApiServer | null = null;

  afterEach(async () => {
    if (server !== null) {
      await server.close();
      server = null;
    }
  });

  function boot(): {
    readonly baseUrl: Promise<string>;
    readonly eventStore: InMemoryEventStore;
    readonly runRepository: InMemoryRunRepository;
    readonly pauseStateRepository: InMemoryPauseStateRepository;
    readonly consumerRegistry: InMemoryConsumerRegistry;
    readonly consumerStateRepository: InMemoryConsumerStateRepository;
    readonly broadcaster: StreamBroadcaster;
    readonly idGenerator: SequentialIdGenerator;
    readonly clock: FixedClock;
  } {
    const eventStore = new InMemoryEventStore();
    const runRepository = new InMemoryRunRepository();
    const consumerRegistry = new InMemoryConsumerRegistry();
    const producerStateRepository = new InMemoryProducerStateRepository();
    const consumerStateRepository = new InMemoryConsumerStateRepository();
    const pauseStateRepository = new InMemoryPauseStateRepository();
    const idGenerator = new SequentialIdGenerator();
    const clock = new FixedClock(new Date("2026-07-05T00:00:00Z"));
    const broadcaster = new StreamBroadcaster();
    const observer = broadcaster;
    const abortRegistry = new InMemoryRunAbortRegistry();
    const dispatcher = buildDispatcher({ runRepository, idGenerator, observer, abortRegistry, clock, consumerRegistry, consumerStateRepository });
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
    const getPauseState = new GetPauseStateInteractor(pauseStateRepository);
    const setPauseState = new SetPauseStateInteractor(pauseStateRepository, observer);
    const replayEvent = new ReplayEventInteractor(eventStore, sink, idGenerator, clock);
    const abortRun = new AbortRunInteractor(runRepository, abortRegistry, observer);
    const restartRun = new RestartRunInteractor(runRepository, consumerRegistry, consumerStateRepository, dispatcher);
    server = new HttpApiServer(
      "127.0.0.1",
      0,
      eventStore,
      runRepository,
      broadcaster,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      getPauseState,
      setPauseState,
      replayEvent,
      abortRun,
      restartRun,
      null,
      null,
      null,
      null,
    );
    return {
      baseUrl: server.start().then(() => `http://127.0.0.1:${server!.address!.port}`),
      eventStore,
      runRepository,
      pauseStateRepository,
      consumerRegistry,
      consumerStateRepository,
      broadcaster,
      idGenerator,
      clock,
    };
  }

  it("GET /api/pause returns the persisted state and PUT /api/pause updates it", async () => {
    const fixture = boot();
    const baseUrl = await fixture.baseUrl;

    const initial = await apiRequest<{ ok: boolean; data: { paused: boolean } }>(baseUrl, "/api/pause");
    expect(initial.status).toBe(200);
    expect(initial.body.data.paused).toBe(false);

    const updated = await requestWithBody<{ ok: boolean; data: { paused: boolean } }>(
      baseUrl,
      "PUT",
      "/api/pause",
      { paused: true },
    );
    expect(updated.body.data.paused).toBe(true);

    const after = await apiRequest<{ ok: boolean; data: { paused: boolean } }>(baseUrl, "/api/pause");
    expect(after.body.data.paused).toBe(true);
  });

  it("PUT /api/pause returns BAD_REQUEST for a missing or non-boolean paused field", async () => {
    const fixture = boot();
    const baseUrl = await fixture.baseUrl;

    const missing = await requestWithBody<{ ok: boolean; error: { code: string } }>(
      baseUrl,
      "PUT",
      "/api/pause",
      {},
    );
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe("BAD_REQUEST");

    const nonBoolean = await requestWithBody<{ ok: boolean; error: { code: string } }>(
      baseUrl,
      "PUT",
      "/api/pause",
      { paused: "yes" },
    );
    expect(nonBoolean.status).toBe(400);
    expect(nonBoolean.body.error.code).toBe("BAD_REQUEST");
  });

  it("PUT /api/pause broadcasts a system.paused_changed stream frame", async () => {
    const credentialStore = new InMemoryCredentialStore();
    const eventStore = new InMemoryEventStore();
    const runRepository = new InMemoryRunRepository();
    const pauseStateRepository = new InMemoryPauseStateRepository();

    let app: App | null = MakeApp({
      idGenerator: new SequentialIdGenerator(),
      eventStore,
      runRepository,
      pauseStateRepository,
      credentialStore,
      api: { host: "127.0.0.1", port: 0 },
      auth: {
        argon2: TEST_ARGON2ID_PARAMETERS,
        handshakeTtlMs: 30_000,
        sessionLifetimeMs: 3_600_000,
        freshnessWindowMs: 5 * 60 * 1000,
        pepper: "integration-pepper",
      },
    });
    app.register(new ConsumerRegistrable(new Consumer<unknown>("c-1", new TypeRule("foo"), new RecordingHandler(successfulOutcome()), [], [])));
    await app.start();

    const baseUrl = resolveApiBaseUrl(app);
    const client = await openAuthenticatedStream(baseUrl, credentialStore, "alice", "secret");
    const session = await buildLoginSession(baseUrl, "alice", "secret");

    const frames: { type: string; data: unknown }[] = [];
    client.on("message", (raw: { toString: () => string }) => {
      frames.push(JSON.parse(raw.toString()));
    });

    const signed = signHeaders(session, "PUT", "/api/pause", JSON.stringify({ paused: true }));
    await fetch(`http://${baseUrl}/api/pause`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...signed },
      body: JSON.stringify({ paused: true }),
    });

    await waitFor(() => (frames.some((f) => f.type === "system.paused_changed") ? frames : undefined));

    const pausedFrame = frames.find((f) => f.type === "system.paused_changed");
    expect(pausedFrame).toBeDefined();
    expect((pausedFrame!.data as { paused: boolean }).paused).toBe(true);

    client.close();
    await app.stop();
    app = null;
  });

  it("POST /api/events/:id/replay returns the new EventDto and emits an event.created frame", async () => {
    const fixture = boot();
    const baseUrl = await fixture.baseUrl;
    const credentialStore = new InMemoryCredentialStore();
    const app = MakeApp({
      idGenerator: fixture.idGenerator,
      eventStore: fixture.eventStore,
      runRepository: fixture.runRepository,
      pauseStateRepository: fixture.pauseStateRepository,
      credentialStore,
      api: { host: "127.0.0.1", port: 0 },
      auth: {
        argon2: TEST_ARGON2ID_PARAMETERS,
        handshakeTtlMs: 30_000,
        sessionLifetimeMs: 3_600_000,
        freshnessWindowMs: 5 * 60 * 1000,
        pepper: "integration-pepper",
      },
    });
    await app.start();
    const streamUrl = resolveApiBaseUrl(app);

    await fixture.eventStore.save(new Event<unknown>("evt-1", "p-1", "pevt-1", fixture.clock.now(), "foo", {}));

    const client = await openAuthenticatedStream(streamUrl, credentialStore, "alice", "secret");
    const session = await buildLoginSession(streamUrl, "alice", "secret");
    const frames: { type: string; data: unknown }[] = [];
    client.on("message", (raw: { toString: () => string }) => {
      frames.push(JSON.parse(raw.toString()));
    });

    const signed = signHeaders(session, "POST", "/api/events/evt-1/replay", "");
    const response = await fetch(`http://${streamUrl}/api/events/evt-1/replay`, {
      method: "POST",
      headers: signed,
    });
    const body = (await response.json()) as { ok: boolean; data: { id: string; producerId: string } };
    expect(response.status).toBe(200);
    expect(body.data.producerId).toBe("concord.replay");

    await waitFor(() => (frames.some((f) => f.type === "event.created") ? frames : undefined));

    client.close();
    await app.stop();
  });

  it("POST /api/events/:id/replay returns FORBIDDEN for a replay-produced event", async () => {
    const fixture = boot();
    const baseUrl = await fixture.baseUrl;
    await fixture.eventStore.save(
      new Event<unknown>("evt-r", "concord.replay", "pevt#1", fixture.clock.now(), "foo", {}),
    );

    const result = await emptyBodyRequest<{ ok: boolean; error: { code: string } }>(
      baseUrl,
      "POST",
      "/api/events/evt-r/replay",
    );
    expect(result.status).toBe(403);
    expect(result.body.error.code).toBe("FORBIDDEN");
  });

  it("POST /api/events/:id/replay returns NOT_FOUND for an unknown event id", async () => {
    const fixture = boot();
    const baseUrl = await fixture.baseUrl;

    const result = await emptyBodyRequest<{ ok: boolean; error: { code: string } }>(
      baseUrl,
      "POST",
      "/api/events/missing/replay",
    );
    expect(result.status).toBe(404);
    expect(result.body.error.code).toBe("NOT_FOUND");
  });

  it("POST /api/runs/:id/abort on a RUNNING run returns the ABORTED RunDto", async () => {
    const credentialStore = new InMemoryCredentialStore();
    const eventStore = new InMemoryEventStore();
    const runRepository = new InMemoryRunRepository();
    const pauseStateRepository = new InMemoryPauseStateRepository();

    const handler = new HangingHandler();

    let app: App | null = MakeApp({
      idGenerator: new SequentialIdGenerator(),
      eventStore,
      runRepository,
      pauseStateRepository,
      credentialStore,
      api: { host: "127.0.0.1", port: 0 },
      auth: {
        argon2: TEST_ARGON2ID_PARAMETERS,
        handshakeTtlMs: 30_000,
        sessionLifetimeMs: 3_600_000,
        freshnessWindowMs: 5 * 60 * 1000,
        pepper: "integration-pepper",
      },
    });
    app.register(new ConsumerRegistrable(new Consumer<unknown>("c-1", new TypeRule("foo"), handler, [], [])));
    const producer = new OnDemandProducer("p-1");
    app.register(producer);
    await app.start();
    const baseUrl = resolveApiBaseUrl(app);

    await seedCredential(credentialStore, "alice", "secret");
    const session = await buildLoginSession(baseUrl, "alice", "secret");

    void producer.emit(new Event<unknown>("evt-1", "p-1", "pevt-1", new Date("2026-07-05T00:00:00Z"), "foo", {}));

    await waitFor(() => (handler.calls.length > 0 ? handler.calls : undefined));
    const runningRunId = handler.calls[0].id;

    const signed = signHeaders(session, "POST", `/api/runs/${runningRunId}/abort`, "");
    const response = await fetch(`http://${baseUrl}/api/runs/${runningRunId}/abort`, {
      method: "POST",
      headers: signed,
    });
    const body = (await response.json()) as { ok: boolean; data: { id: string; state: string } };
    expect(response.status).toBe(200);
    expect(body.data.id).toBe(runningRunId);
    expect(body.data.state).toBe("ABORTED");

    await app.stop();
    app = null;
  });

  it("POST /api/runs/:id/abort on a terminal run returns CONFLICT", async () => {
    const fixture = boot();
    const baseUrl = await fixture.baseUrl;

    const event = new Event<unknown>("evt-1", "p-1", "pevt-1", fixture.clock.now(), "foo", {});
    await fixture.eventStore.save(event);
    await fixture.runRepository.save(new Run("run-done", event, "c-1", "SUCCEEDED"));

    const result = await emptyBodyRequest<{ ok: boolean; error: { code: string } }>(
      baseUrl,
      "POST",
      "/api/runs/run-done/abort",
    );
    expect(result.status).toBe(409);
    expect(result.body.error.code).toBe("CONFLICT");
  });

  it("POST /api/runs/:id/restart on a terminal run returns the new RunDto", async () => {
    const fixture = boot();
    const baseUrl = await fixture.baseUrl;
    fixture.consumerRegistry.register(
      new Consumer<unknown>("c-1", new TypeRule("foo"), new RecordingHandler(successfulOutcome()), [], []),
    );

    const event = new Event<unknown>("evt-1", "p-1", "pevt-1", fixture.clock.now(), "foo", {});
    await fixture.eventStore.save(event);
    await fixture.runRepository.save(new Run("run-1", event, "c-1", "SUCCEEDED"));

    const result = await emptyBodyRequest<{ ok: boolean; data: { id: string; state: string; consumerId: string } }>(
      baseUrl,
      "POST",
      "/api/runs/run-1/restart",
    );

    expect(result.status).toBe(200);
    expect(result.body.data.id).not.toBe("run-1");
    expect(result.body.data.consumerId).toBe("c-1");
    expect(result.body.data.state).toBe("RUNNING");
  });

  it("POST /api/runs/:id/restart on a RUNNING run returns CONFLICT", async () => {
    const fixture = boot();
    const baseUrl = await fixture.baseUrl;

    const event = new Event<unknown>("evt-1", "p-1", "pevt-1", fixture.clock.now(), "foo", {});
    await fixture.eventStore.save(event);
    await fixture.runRepository.save(new Run("run-running", event, "c-1", "RUNNING"));

    const result = await emptyBodyRequest<{ ok: boolean; error: { code: string } }>(
      baseUrl,
      "POST",
      "/api/runs/run-running/restart",
    );
    expect(result.status).toBe(409);
    expect(result.body.error.code).toBe("CONFLICT");
  });
});

describe("HTTP API — event templates", () => {
  let app: App | null = null;

  afterEach(async () => {
    if (app !== null) {
      await app.stop();
      app = null;
    }
  });

  async function boot(): Promise<{ baseUrl: string; session: LoginSession }> {
    const credentialStore = new InMemoryCredentialStore();
    app = MakeApp({
      idGenerator: new SequentialIdGenerator(),
      eventStore: new InMemoryEventStore(),
      runRepository: new InMemoryRunRepository(),
      credentialStore,
      api: { host: "127.0.0.1", port: 0 },
      auth: {
        argon2: TEST_ARGON2ID_PARAMETERS,
        handshakeTtlMs: 30_000,
        sessionLifetimeMs: 3_600_000,
        freshnessWindowMs: 5 * 60 * 1000,
        pepper: "integration-pepper",
      },
    });
    await app.start();
    const baseUrl = resolveApiBaseUrl(app);
    await seedCredential(credentialStore, "alice", "secret");
    const session = await buildLoginSession(baseUrl, "alice", "secret");
    return { baseUrl, session };
  }

  async function signedFetch(
    baseUrl: string,
    session: LoginSession,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: unknown }> {
    const bodyText = body === undefined ? "" : JSON.stringify(body);
    const headers = signHeaders(session, method, path, bodyText);
    const init: RequestInit = { method, headers: headers as Record<string, string> };
    if (body !== undefined) {
      init.body = bodyText;
    }
    const response = await fetch(`http://${baseUrl}${path}`, init);
    const text = await response.text();
    let parsed: unknown = text;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    return { status: response.status, body: parsed };
  }

  it("GET /api/event-templates returns the descriptors including the built-in raw-json template", async () => {
    const { baseUrl, session } = await boot();

    const result = await signedFetch(baseUrl, session, "GET", "/api/event-templates");
    expect(result.status).toBe(200);
    const body = result.body as { ok: boolean; data: { id: string; producerId: string; fields: { key: string; placeholder?: string }[] }[] };
    const rawJson = body.data.find((t) => t.id === "raw-json");
    expect(rawJson).toBeDefined();
    expect(rawJson!.producerId).toBe("web-ui");
    expect(rawJson!.fields[0].key).toBe("json");
    expect(rawJson!.fields[0].placeholder).toContain("eventId");
  });

  it("POST /api/event-templates/raw-json/emit with valid JSON returns the created EventDto and broadcasts event.created", async () => {
    const credentialStore = new InMemoryCredentialStore();
    app = MakeApp({
      idGenerator: new SequentialIdGenerator(),
      eventStore: new InMemoryEventStore(),
      runRepository: new InMemoryRunRepository(),
      credentialStore,
      api: { host: "127.0.0.1", port: 0 },
      auth: {
        argon2: TEST_ARGON2ID_PARAMETERS,
        handshakeTtlMs: 30_000,
        sessionLifetimeMs: 3_600_000,
        freshnessWindowMs: 5 * 60 * 1000,
        pepper: "integration-pepper",
      },
    });
    app.register(new ConsumerRegistrable(new Consumer<unknown>("c-1", new TypeRule("rawjson"), new RecordingHandler(successfulOutcome()), [], [])));
    await app.start();

    const baseUrl = resolveApiBaseUrl(app);
    await seedCredential(credentialStore, "alice", "secret");
    const session = await buildLoginSession(baseUrl, "alice", "secret");

    const streamClient = await openAuthenticatedStream(baseUrl, credentialStore, "alice", "secret");
    const frames: { type: string; data: { id?: string; type?: string; payload?: unknown } }[] = [];
    streamClient.on("message", (raw: { toString: () => string }) => {
      frames.push(JSON.parse(raw.toString()));
    });

    const result = await signedFetch(baseUrl, session, "POST", "/api/event-templates/raw-json/emit", {
      answers: { json: JSON.stringify({ eventId: "pevt-1", hello: "world" }) },
    });
    expect(result.status).toBe(200);
    const body = result.body as { ok: boolean; data: { type: string; producerEventId: string; producerId: string; payload: unknown } };
    expect(body.data.type).toBe("rawjson");
    expect(body.data.producerEventId).toBe("pevt-1");
    expect(body.data.producerId).toBe("web-ui");
    expect(body.data.payload).toEqual({ eventId: "pevt-1", hello: "world" });

    await waitFor(() => (frames.length >= 1 ? frames : undefined));
    const created = frames.find((frame) => frame.type === "event.created");
    expect(created).toBeDefined();
    expect(created!.data.type).toBe("rawjson");

    streamClient.close();
  });

  it("POST /api/event-templates/raw-json/emit with unparseable JSON returns BAD_REQUEST", async () => {
    const { baseUrl, session } = await boot();

    const result = await signedFetch(baseUrl, session, "POST", "/api/event-templates/raw-json/emit", {
      answers: { json: "this is not json" },
    });
    expect(result.status).toBe(400);
    expect((result.body as { ok: boolean; error: { code: string } }).error.code).toBe("BAD_REQUEST");
  });

  it("POST /api/event-templates/raw-json/emit with a JSON object missing eventId returns BAD_REQUEST", async () => {
    const { baseUrl, session } = await boot();

    const result = await signedFetch(baseUrl, session, "POST", "/api/event-templates/raw-json/emit", {
      answers: { json: JSON.stringify({ hello: "world" }) },
    });
    expect(result.status).toBe(400);
    expect((result.body as { ok: boolean; error: { code: string } }).error.code).toBe("BAD_REQUEST");
  });

  it("POST /api/event-templates/:id/emit for an unknown template id returns NOT_FOUND", async () => {
    const { baseUrl, session } = await boot();

    const result = await signedFetch(baseUrl, session, "POST", "/api/event-templates/ghost/emit", {
      answers: { json: "{}" },
    });
    expect(result.status).toBe(404);
    expect((result.body as { ok: boolean; error: { code: string } }).error.code).toBe("NOT_FOUND");
  });

  it("POST /api/event-templates/:id/emit without an answers object returns BAD_REQUEST", async () => {
    const { baseUrl, session } = await boot();

    const result = await signedFetch(baseUrl, session, "POST", "/api/event-templates/raw-json/emit", {
      notAnswers: "x",
    });
    expect(result.status).toBe(400);
    expect((result.body as { ok: boolean; error: { code: string } }).error.code).toBe("BAD_REQUEST");
  });
});

describe("HTTP API — widgets", () => {
  let server: HttpApiServer | null = null;

  afterEach(async () => {
    if (server !== null) {
      await server.close();
      server = null;
    }
  });

  function boot(registry: InMemoryWidgetRegistry): Promise<string> {
    const broadcaster = new StreamBroadcaster();
    server = new HttpApiServer(
      "127.0.0.1",
      0,
      new InMemoryEventStore(),
      new InMemoryRunRepository(),
      broadcaster,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      registry,
    );
    return server.start().then(() => `http://127.0.0.1:${server!.address!.port}`);
  }

  it("GET /api/widgets returns the registered descriptors in insertion order", async () => {
    const registry = new InMemoryWidgetRegistry();
    registry.register(new FakeWidget("a", "fake", { variant: "static" }, { kind: "fake", message: "1" }));
    registry.register(new FakeWidget("b", "fake", { variant: "interval", intervalMs: 15000 }, { kind: "fake", message: "2" }));

    const baseUrl = await boot(registry);

    const result = await apiRequest<{
      ok: boolean;
      data: { items: { id: string; kind: string; refresh: { variant: string; intervalMs?: number } }[] };
    }>(baseUrl, "/api/widgets");

    expect(result.status).toBe(200);
    expect(result.body.data.items.map((item) => item.id)).toEqual(["a", "b"]);
    expect(result.body.data.items[1].refresh).toEqual({ variant: "interval", intervalMs: 15000 });
  });

  it("GET /api/widgets/:id returns the rendered payload verbatim", async () => {
    const registry = new InMemoryWidgetRegistry();
    registry.register(new FakeWidget("a", "fake", { variant: "static" }, { kind: "fake", message: "hello" }));

    const baseUrl = await boot(registry);

    const result = await apiRequest<{ ok: boolean; data: { kind: string; message: string } }>(baseUrl, "/api/widgets/a");

    expect(result.status).toBe(200);
    expect(result.body.data).toEqual({ kind: "fake", message: "hello" });
  });

  it("GET /api/widgets/:id returns NOT_FOUND for an unknown widget id", async () => {
    const registry = new InMemoryWidgetRegistry();

    const baseUrl = await boot(registry);

    const result = await apiRequest<{ ok: boolean; error: { code: string } }>(baseUrl, "/api/widgets/missing");

    expect(result.status).toBe(404);
    expect(result.body.error.code).toBe("NOT_FOUND");
  });
});
