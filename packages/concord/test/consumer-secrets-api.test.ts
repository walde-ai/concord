import { describe, it, expect } from "vitest";
import { HttpApiServer } from "../src/infra/adapters/api/http-api-server";
import { StreamBroadcaster } from "../src/infra/adapters/api/stream-broadcaster";
import { InMemoryEventStore } from "../src/infra/adapters/stores/in-memory-event-store";
import { InMemoryRunRepository } from "../src/infra/adapters/stores/in-memory-run-repository";
import { InMemoryConsumerRegistry } from "../src/infra/adapters/registry/in-memory-consumer-registry";
import { InMemoryConsumerStateRepository } from "../src/infra/adapters/stores/in-memory-consumer-state-repository";
import { InMemoryConsumerConfigRepository } from "../src/infra/adapters/stores/in-memory-consumer-config-repository";
import { MergingConsumerConfigResolver } from "../src/infra/adapters/config/merging-consumer-config-resolver";
import { RepositoryConsumerSecretResolver } from "../src/infra/adapters/config/repository-consumer-secret-resolver";
import { ConsumerDescriptorBuilder } from "../src/domain/interactors/consumer-descriptor-builder";
import { ListConsumersInteractor } from "../src/domain/interactors/list-consumers-interactor";
import { SetConsumerSecretsInteractor } from "../src/domain/interactors/set-consumer-secrets-interactor";
import { Consumer } from "../src/domain/entities/consumer";
import { AGENT_GITHUB_TOKEN_SECRET } from "../src/infra/adapters/consumers/agents/agent-config-schema";
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

function bootServer(): { readonly server: HttpApiServer } {
  const eventStore = new InMemoryEventStore();
  const runRepository = new InMemoryRunRepository();
  const consumerRegistry = new InMemoryConsumerRegistry();
  consumerRegistry.register(
    new Consumer<unknown>("worker-a", new TypeRule("foo"), new RecordingHandler(successfulOutcome()), [], AGENT_GITHUB_TOKEN_SECRET),
  );
  consumerRegistry.register(
    new Consumer<unknown>("stdio", new TypeRule("bar"), new RecordingHandler(successfulOutcome()), [], []),
  );
  const consumerStates = new InMemoryConsumerStateRepository();
  const consumerConfigs = new InMemoryConsumerConfigRepository();
  const broadcaster = new StreamBroadcaster();
  const configResolver = new MergingConsumerConfigResolver(consumerRegistry, consumerConfigs);
  const secretResolver = new RepositoryConsumerSecretResolver(consumerRegistry, consumerConfigs);
  const descriptorBuilder = new ConsumerDescriptorBuilder(consumerRegistry, consumerStates, configResolver, secretResolver);
  const listConsumers = new ListConsumersInteractor(consumerRegistry, descriptorBuilder);
  const setConsumerSecrets = new SetConsumerSecretsInteractor(consumerRegistry, consumerConfigs, descriptorBuilder);
  const server = new HttpApiServer(
    "127.0.0.1",
    0,
    eventStore,
    runRepository,
    broadcaster,
    null, // listProducers
    listConsumers,
    null, // setProducerEnabled
    null, // setConsumerEnabled
    null, // createContext
    null, // updateContext
    null, // deleteContext
    null, // listContexts
    null, // beginLogin
    null, // completeLogin
    null, // authenticateRequest
    null, // emitEvent
    null, // getPauseState
    null, // setPauseState
    null, // replayEvent
    null, // abortRun
    null, // restartRun
    null, // getPeakHours
    null, // setPeakHours
    null, // setConsumerWaitForOffPeak
    null, // setConsumerConfig
    setConsumerSecrets,
  );
  return { server };
}

describe("GET /api/consumers secret schema", () => {
  it("returns secretParameters matching the declared schema and secretNames matching stored keys", async () => {
    const { server } = bootServer();
    await server.start();
    const baseUrl = `http://127.0.0.1:${server.address!.port}`;

    await putJson(
      baseUrl,
      "/api/consumers/worker-a/secrets",
      { secrets: { upserts: [{ name: "githubToken", value: "tok-1" }], deletes: [] } },
    );

    const result = await getJson<{ ok: boolean; data: { id: string; secretParameters: { key: string }[]; secretNames: string[] }[] }>(
      baseUrl,
      "/api/consumers",
    );
    const target = result.body.data.find((c) => c.id === "worker-a");
    expect(target?.secretParameters).toEqual([{ key: "githubToken", label: "GitHub token" }]);
    expect(target?.secretNames).toEqual(["githubToken"]);
    await server.close();
  });

  it("never includes secret values in the response body", async () => {
    const { server } = bootServer();
    await server.start();
    const baseUrl = `http://127.0.0.1:${server.address!.port}`;

    await putJson(
      baseUrl,
      "/api/consumers/worker-a/secrets",
      { secrets: { upserts: [{ name: "githubToken", value: "SECRET-VALUE-123" }], deletes: [] } },
    );

    const consumers = await getJson<{ ok: boolean; data: unknown[] }>(baseUrl, "/api/consumers");
    const serialized = JSON.stringify(consumers.body);
    expect(serialized).not.toContain("SECRET-VALUE-123");
    await server.close();
  });
});

describe("PUT /api/consumers/:id/secrets", () => {
  it("applies a valid upsert and returns the updated dto whose secretNames reflect the change", async () => {
    const { server } = bootServer();
    await server.start();
    const baseUrl = `http://127.0.0.1:${server.address!.port}`;

    const result = await putJson<{ ok: boolean; data: { id: string; secretNames: string[] } }>(
      baseUrl,
      "/api/consumers/worker-a/secrets",
      { secrets: { upserts: [{ name: "githubToken", value: "tok-1" }], deletes: [] } },
    );
    expect(result.status).toBe(200);
    expect(result.body.data.secretNames).toEqual(["githubToken"]);

    const consumers = await getJson<{ ok: boolean; data: { id: string; secretNames: string[] }[] }>(
      baseUrl,
      "/api/consumers",
    );
    const target = consumers.body.data.find((c) => c.id === "worker-a");
    expect(target?.secretNames).toEqual(["githubToken"]);
    await server.close();
  });

  it("returns BAD_REQUEST for an upsert name not declared on the consumer", async () => {
    const { server } = bootServer();
    await server.start();
    const baseUrl = `http://127.0.0.1:${server.address!.port}`;

    const result = await putJson<{ ok: boolean; error: { code: string } }>(
      baseUrl,
      "/api/consumers/worker-a/secrets",
      { secrets: { upserts: [{ name: "unknownKey", value: "x" }], deletes: [] } },
    );
    expect(result.status).toBe(400);
    expect(result.body.error.code).toBe("BAD_REQUEST");
    await server.close();
  });

  it("returns BAD_REQUEST for a name present in both upserts and deletes", async () => {
    const { server } = bootServer();
    await server.start();
    const baseUrl = `http://127.0.0.1:${server.address!.port}`;

    const result = await putJson<{ ok: boolean; error: { code: string } }>(
      baseUrl,
      "/api/consumers/worker-a/secrets",
      { secrets: { upserts: [{ name: "githubToken", value: "x" }], deletes: ["githubToken"] } },
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
      "/api/consumers/unknown/secrets",
      { secrets: { upserts: [{ name: "githubToken", value: "x" }], deletes: [] } },
    );
    expect(result.status).toBe(404);
    expect(result.body.error.code).toBe("NOT_FOUND");
    await server.close();
  });
});
