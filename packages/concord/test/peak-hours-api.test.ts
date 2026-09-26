import { describe, it, expect } from "vitest";
import { WebSocket } from "ws";
import { HttpApiServer } from "../src/infra/adapters/api/http-api-server";
import { StreamBroadcaster } from "../src/infra/adapters/api/stream-broadcaster";
import { InMemoryEventStore } from "../src/infra/adapters/stores/in-memory-event-store";
import { InMemoryRunRepository } from "../src/infra/adapters/stores/in-memory-run-repository";
import { InMemoryConsumerRegistry } from "../src/infra/adapters/registry/in-memory-consumer-registry";
import { InMemoryConsumerStateRepository } from "../src/infra/adapters/stores/in-memory-consumer-state-repository";
import { InMemoryConsumerConfigRepository } from "../src/infra/adapters/stores/in-memory-consumer-config-repository";
import { InMemoryPeakHoursRepository } from "../src/infra/adapters/stores/in-memory-peak-hours-repository";
import { MergingConsumerConfigResolver } from "../src/infra/adapters/config/merging-consumer-config-resolver";
import { RepositoryConsumerSecretResolver } from "../src/infra/adapters/config/repository-consumer-secret-resolver";
import { ConsumerDescriptorBuilder } from "../src/domain/interactors/consumer-descriptor-builder";
import { ListConsumersInteractor } from "../src/domain/interactors/list-consumers-interactor";
import { GetPeakHoursInteractor } from "../src/domain/interactors/get-peak-hours-interactor";
import { SetPeakHoursInteractor } from "../src/domain/interactors/set-peak-hours-interactor";
import { SetConsumerConfigInteractor } from "../src/domain/interactors/set-consumer-config-interactor";
import { SetConsumerWaitForOffPeakInteractor } from "../src/domain/interactors/set-consumer-wait-for-off-peak-interactor";
import { Consumer } from "../src/domain/entities/consumer";
import { AGENT_CONSUMER_CONFIG_SCHEMA } from "../src/infra/adapters/consumers/agents/agent-config-schema";
import { TypeRule, RecordingHandler, successfulOutcome } from "./helpers";

interface ApiResponse<T> {
  readonly status: number;
  readonly body: T;
}

async function putJson<T>(baseUrl: string, path: string, payload: unknown): Promise<ApiResponse<T>> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = (await response.json()) as T;
  return { status: response.status, body };
}

async function getJson<T>(baseUrl: string, path: string): Promise<ApiResponse<T>> {
  const response = await fetch(`${baseUrl}${path}`, { method: "GET" });
  const body = (await response.json()) as T;
  return { status: response.status, body };
}

function bootServer(): { readonly server: HttpApiServer; readonly peakHoursRepository: InMemoryPeakHoursRepository } {
  const eventStore = new InMemoryEventStore();
  const runRepository = new InMemoryRunRepository();
  const consumerRegistry = new InMemoryConsumerRegistry();
  consumerRegistry.register(new Consumer<unknown>("pr-publish", new TypeRule("foo"), new RecordingHandler(successfulOutcome()), AGENT_CONSUMER_CONFIG_SCHEMA, []));
  consumerRegistry.register(new Consumer<unknown>("stdio", new TypeRule("bar"), new RecordingHandler(successfulOutcome()), [], []));
  const consumerStates = new InMemoryConsumerStateRepository();
  const consumerConfigs = new InMemoryConsumerConfigRepository();
  const peakHoursRepository = new InMemoryPeakHoursRepository();
  const broadcaster = new StreamBroadcaster();
  const configResolver = new MergingConsumerConfigResolver(consumerRegistry, consumerConfigs);
  const secretResolver = new RepositoryConsumerSecretResolver(consumerRegistry, consumerConfigs);
  const descriptorBuilder = new ConsumerDescriptorBuilder(consumerRegistry, consumerStates, configResolver, secretResolver);
  const listConsumers = new ListConsumersInteractor(consumerRegistry, descriptorBuilder);
  const getPeakHours = new GetPeakHoursInteractor(peakHoursRepository);
  const setPeakHours = new SetPeakHoursInteractor(peakHoursRepository, broadcaster);
  const setConsumerConfig = new SetConsumerConfigInteractor(consumerRegistry, consumerConfigs, descriptorBuilder);
  const setConsumerWaitForOffPeak = new SetConsumerWaitForOffPeakInteractor(consumerStates, descriptorBuilder);
  const server = new HttpApiServer(
    "127.0.0.1",
    0,
    eventStore,
    runRepository,
    broadcaster,
    null,
    listConsumers,
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
    getPeakHours,
    setPeakHours,
    setConsumerWaitForOffPeak,
    setConsumerConfig,
  );
  return { server, peakHoursRepository };
}

describe("GET /api/peak-hours", () => {
  it("returns null by default", async () => {
    const { server } = bootServer();
    await server.start();
    const baseUrl = `http://127.0.0.1:${server.address!.port}`;
    const result = await getJson<{ ok: boolean; data: { peakHours: unknown } }>(baseUrl, "/api/peak-hours");
    expect(result.status).toBe(200);
    expect(result.body.data.peakHours).toBeNull();
    await server.close();
  });
});

describe("PUT /api/peak-hours", () => {
  it("stores and returns the peak hours", async () => {
    const { server, peakHoursRepository } = bootServer();
    await server.start();
    const baseUrl = `http://127.0.0.1:${server.address!.port}`;
    const result = await putJson<{ ok: boolean; data: { peakHours: { start: string; end: string; timezone: string } } }>(
      baseUrl,
      "/api/peak-hours",
      { start: "09:00", end: "17:00", timezone: "Europe/Zurich" },
    );
    expect(result.status).toBe(200);
    expect(result.body.data.peakHours).toEqual({ start: "09:00", end: "17:00", timezone: "Europe/Zurich" });
    expect((await peakHoursRepository.get())?.timezone).toBe("Europe/Zurich");
    await server.close();
  });

  it("clears the setting on null", async () => {
    const { server, peakHoursRepository } = bootServer();
    await peakHoursRepository.set({ start: "09:00", end: "17:00", timezone: "UTC" });
    await server.start();
    const baseUrl = `http://127.0.0.1:${server.address!.port}`;
    const result = await putJson<{ ok: boolean; data: { peakHours: unknown } }>(baseUrl, "/api/peak-hours", null);
    expect(result.status).toBe(200);
    expect(result.body.data.peakHours).toBeNull();
    expect(await peakHoursRepository.get()).toBeNull();
    await server.close();
  });

  it("returns BAD_REQUEST for a malformed HH:MM", async () => {
    const { server } = bootServer();
    await server.start();
    const baseUrl = `http://127.0.0.1:${server.address!.port}`;
    const result = await putJson<{ ok: boolean; error: { code: string } }>(
      baseUrl,
      "/api/peak-hours",
      { start: "9", end: "17:00", timezone: "UTC" },
    );
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe("BAD_REQUEST");
    await server.close();
  });

  it("returns BAD_REQUEST for an unknown timezone", async () => {
    const { server } = bootServer();
    await server.start();
    const baseUrl = `http://127.0.0.1:${server.address!.port}`;
    const result = await putJson<{ ok: boolean; error: { code: string } }>(
      baseUrl,
      "/api/peak-hours",
      { start: "09:00", end: "17:00", timezone: "Not/A/Zone" },
    );
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe("BAD_REQUEST");
    await server.close();
  });

  it("broadcasts a system.peak_hours_changed frame on a connected WebSocket", async () => {
    const { server } = bootServer();
    await server.start();
    const port = server.address!.port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/stream`);
    await new Promise<void>((resolve) => ws.on("open", () => resolve()));
    const frames: unknown[] = [];
    ws.on("message", (data) => frames.push(JSON.parse(data.toString())));
    await new Promise((resolve) => setTimeout(resolve, 50));

    await putJson(baseUrl(`server`), "/api/peak-hours", { start: "09:00", end: "17:00", timezone: "UTC" });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const changed = frames.find((frame) => (frame as { type: string }).type === "system.peak_hours_changed");
    expect(changed).toBeDefined();
    ws.close();
    await server.close();

    function baseUrl(): string {
      return `http://127.0.0.1:${port}`;
    }
  });
});

describe("PUT /api/consumers/:id/wait-for-off-peak", () => {
  it("sets the flag and returns the updated consumer dto", async () => {
    const { server } = bootServer();
    await server.start();
    const baseUrl = `http://127.0.0.1:${server.address!.port}`;
    const result = await putJson<{ ok: boolean; data: { id: string; waitForOffPeak: boolean } }>(
      baseUrl,
      "/api/consumers/pr-publish/wait-for-off-peak",
      { waitForOffPeak: true },
    );
    expect(result.status).toBe(200);
    expect(result.body.data.waitForOffPeak).toBe(true);

    const consumers = await getJson<{ ok: boolean; data: { id: string; waitForOffPeak: boolean }[] }>(baseUrl, "/api/consumers");
    const target = consumers.body.data.find((c) => c.id === "pr-publish");
    expect(target?.waitForOffPeak).toBe(true);
    await server.close();
  });

  it("returns NOT_FOUND for an unknown consumer id", async () => {
    const { server } = bootServer();
    await server.start();
    const baseUrl = `http://127.0.0.1:${server.address!.port}`;
    const result = await putJson<{ ok: boolean; error: { code: string } }>(
      baseUrl,
      "/api/consumers/unknown/wait-for-off-peak",
      { waitForOffPeak: true },
    );
    expect(result.status).toBe(404);
    expect(result.body.error.code).toBe("NOT_FOUND");
    await server.close();
  });
});

describe("PUT /api/consumers/:id/config", () => {
  it("persists config values and returns the updated consumer dto", async () => {
    const { server } = bootServer();
    await server.start();
    const baseUrl = `http://127.0.0.1:${server.address!.port}`;
    const result = await putJson<{ ok: boolean; data: { id: string; configValues: Record<string, string> } }>(
      baseUrl,
      "/api/consumers/pr-publish/config",
      { values: { modelId: "anthropic/claude-sonnet-4.5", agentName: "build" } },
    );
    expect(result.status).toBe(200);
    expect(result.body.data.configValues).toEqual({
      modelId: "anthropic/claude-sonnet-4.5",
      agentName: "build",
      maxInputRounds: "0",
      runTimeoutMs: String(60 * 60 * 1000),
    });
    await server.close();
  });

  it("rejects keys not in the schema with BAD_REQUEST", async () => {
    const { server } = bootServer();
    await server.start();
    const baseUrl = `http://127.0.0.1:${server.address!.port}`;
    const result = await putJson<{ ok: boolean; error: { code: string } }>(
      baseUrl,
      "/api/consumers/pr-publish/config",
      { values: { unknownKey: "x" } },
    );
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe("BAD_REQUEST");
    await server.close();
  });

  it("rejects non-string values with BAD_REQUEST", async () => {
    const { server } = bootServer();
    await server.start();
    const baseUrl = `http://127.0.0.1:${server.address!.port}`;
    const result = await putJson<{ ok: boolean; error: { code: string } }>(
      baseUrl,
      "/api/consumers/pr-publish/config",
      { values: { modelId: 123 } },
    );
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe("BAD_REQUEST");
    await server.close();
  });

  it("returns NOT_FOUND for an unknown consumer id", async () => {
    const { server } = bootServer();
    await server.start();
    const baseUrl = `http://127.0.0.1:${server.address!.port}`;
    const result = await putJson<{ ok: boolean; error: { code: string } }>(
      baseUrl,
      "/api/consumers/unknown/config",
      { values: {} },
    );
    expect(result.status).toBe(404);
    expect(result.body.error.code).toBe("NOT_FOUND");
    await server.close();
  });
});
