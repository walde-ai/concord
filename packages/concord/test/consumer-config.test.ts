import { describe, it, expect } from "vitest";
import { Consumer } from "../src/domain/entities/consumer";
import type { ConsumerConfigParameter } from "../src/domain/component";
import { InMemoryConsumerConfigRepository } from "../src/infra/adapters/stores/in-memory-consumer-config-repository";
import { InMemoryConsumerStateRepository } from "../src/infra/adapters/stores/in-memory-consumer-state-repository";
import { InMemoryConsumerRegistry } from "../src/infra/adapters/registry/in-memory-consumer-registry";
import { MergingConsumerConfigResolver } from "../src/infra/adapters/config/merging-consumer-config-resolver";
import { ConfigRunTimeoutResolver } from "../src/infra/adapters/config/config-run-timeout-resolver";
import { DEFAULT_RUN_TIMEOUT_MS } from "../src/domain/ports/out/run-timeout-resolver";
import { TypeRule, RecordingHandler, successfulOutcome } from "./helpers";
import { FakeConsumerConfigResolver } from "./fakes";
import { AGENT_CONSUMER_CONFIG_SCHEMA } from "../src/infra/adapters/consumers/agents/agent-config-schema";
import { SqliteConsumerConfigRepository } from "../src/infra/adapters/stores/sqlite/sqlite-consumer-config-repository";
import { SqliteConsumerStateRepository } from "../src/infra/adapters/stores/sqlite/sqlite-consumer-state-repository";
import { SqliteDatabase } from "../src/infra/adapters/stores/sqlite/sqlite-database";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCHEMA: readonly ConsumerConfigParameter[] = [
  { key: "modelId", label: "Model", required: true, defaultValue: "" },
  { key: "agentName", label: "Agent", required: true, defaultValue: "opencode" },
];

describe("MergingConsumerConfigResolver", () => {
  it("overlays persisted values on schema defaults", async () => {
    const registry = new InMemoryConsumerRegistry();
    registry.register(new Consumer<unknown>("c-1", new TypeRule("foo"), new RecordingHandler(successfulOutcome()), SCHEMA, []));
    const repo = new InMemoryConsumerConfigRepository();
    await repo.set("c-1", { modelId: "anthropic/claude-sonnet-4.5" });
    const resolver = new MergingConsumerConfigResolver(registry, repo);

    const values = await resolver.resolve("c-1");
    expect(values).toEqual({ modelId: "anthropic/claude-sonnet-4.5", agentName: "opencode" });
  });

  it("fills the default for an absent key", async () => {
    const registry = new InMemoryConsumerRegistry();
    registry.register(new Consumer<unknown>("c-1", new TypeRule("foo"), new RecordingHandler(successfulOutcome()), SCHEMA, []));
    const repo = new InMemoryConsumerConfigRepository();
    const resolver = new MergingConsumerConfigResolver(registry, repo);

    const values = await resolver.resolve("c-1");
    expect(values).toEqual({ modelId: "", agentName: "opencode" });
  });

  it("returns an empty map for a schema-less consumer", async () => {
    const registry = new InMemoryConsumerRegistry();
    registry.register(new Consumer<unknown>("c-1", new TypeRule("foo"), new RecordingHandler(successfulOutcome()), [], []));
    const repo = new InMemoryConsumerConfigRepository();
    const resolver = new MergingConsumerConfigResolver(registry, repo);

    expect(await resolver.resolve("c-1")).toEqual({});
  });

  it("reflects an edited persisted value on the next call without reconstruction", async () => {
    const registry = new InMemoryConsumerRegistry();
    registry.register(new Consumer<unknown>("c-1", new TypeRule("foo"), new RecordingHandler(successfulOutcome()), SCHEMA, []));
    const repo = new InMemoryConsumerConfigRepository();
    const resolver = new MergingConsumerConfigResolver(registry, repo);

    expect((await resolver.resolve("c-1")).agentName).toBe("opencode");
    await repo.set("c-1", { agentName: "build" });
    expect((await resolver.resolve("c-1")).agentName).toBe("build");
  });
});

describe("InMemoryConsumerConfigRepository", () => {
  it("round-trips a values map and replaces the whole map on upsert", async () => {
    const repo = new InMemoryConsumerConfigRepository();
    expect(await repo.get("c-1")).toEqual({});
    await repo.set("c-1", { modelId: "a/b", agentName: "build" });
    expect(await repo.get("c-1")).toEqual({ modelId: "a/b", agentName: "build" });
    await repo.set("c-1", { modelId: "c/d" });
    expect(await repo.get("c-1")).toEqual({ modelId: "c/d" });
  });
});

describe("InMemoryConsumerStateRepository waitForOffPeak", () => {
  it("defaults to false and toggles independently of enabled", async () => {
    const repo = new InMemoryConsumerStateRepository();
    expect(await repo.getWaitForOffPeak("c-1")).toBe(false);
    await repo.setEnabled("c-1", false);
    expect(await repo.getWaitForOffPeak("c-1")).toBe(false);
    await repo.setWaitForOffPeak("c-1", true);
    expect(await repo.get("c-1")).toBe(false);
    expect(await repo.getWaitForOffPeak("c-1")).toBe(true);
  });
});

describe("SqliteConsumerConfigRepository", () => {
  function makeRepo(path: string): SqliteConsumerConfigRepository {
    return new SqliteConsumerConfigRepository(new SqliteDatabase(path));
  }

  it("round-trips a values map and a missing row reads back as empty", async () => {
    const path = join(tmpdir(), `concord-config-${Date.now()}-${Math.random()}.db`);
    const repo = makeRepo(path);
    expect(await repo.get("c-1")).toEqual({});
    await repo.set("c-1", { modelId: "anthropic/claude", agentName: "build" });
    expect(await repo.get("c-1")).toEqual({ modelId: "anthropic/claude", agentName: "build" });
    await repo.set("c-1", { modelId: "openai/gpt" });
    expect(await repo.get("c-1")).toEqual({ modelId: "openai/gpt" });
  });
});

describe("SqliteConsumerStateRepository waitForOffPeak", () => {
  function makeRepo(path: string): SqliteConsumerStateRepository {
    return new SqliteConsumerStateRepository(new SqliteDatabase(path));
  }

  it("defaults to false, toggles, and does not clobber enabled", async () => {
    const path = join(tmpdir(), `concord-state-${Date.now()}-${Math.random()}.db`);
    const repo = makeRepo(path);
    expect(await repo.getWaitForOffPeak("c-1")).toBe(false);
    await repo.setEnabled("c-1", false);
    await repo.setWaitForOffPeak("c-1", true);
    expect(await repo.get("c-1")).toBe(false);
    expect(await repo.getWaitForOffPeak("c-1")).toBe(true);
    await repo.setEnabled("c-1", true);
    expect(await repo.getWaitForOffPeak("c-1")).toBe(true);
  });
});

describe("AGENT_CONSUMER_CONFIG_SCHEMA", () => {
  it("declares modelId, agentName, maxInputRounds and runTimeoutMs parameters", () => {
    expect(AGENT_CONSUMER_CONFIG_SCHEMA.map((p) => p.key)).toEqual(["modelId", "agentName", "maxInputRounds", "runTimeoutMs"]);
    const agent = AGENT_CONSUMER_CONFIG_SCHEMA.find((p) => p.key === "agentName");
    expect(agent?.defaultValue).toBe("");
    expect(agent?.required).toBe(true);
    const model = AGENT_CONSUMER_CONFIG_SCHEMA.find((p) => p.key === "modelId");
    expect(model?.defaultValue).toBe("");
    const rounds = AGENT_CONSUMER_CONFIG_SCHEMA.find((p) => p.key === "maxInputRounds");
    expect(rounds?.defaultValue).toBe("0");
    expect(rounds?.required).toBe(true);
    const timeout = AGENT_CONSUMER_CONFIG_SCHEMA.find((p) => p.key === "runTimeoutMs");
    expect(timeout?.defaultValue).toBe(String(60 * 60 * 1000));
    expect(timeout?.required).toBe(true);
  });
});

describe("ConfigRunTimeoutResolver", () => {
  it("resolves the runTimeoutMs config value as milliseconds", async () => {
    const resolver = new ConfigRunTimeoutResolver(new FakeConsumerConfigResolver({ runTimeoutMs: "5000" }), DEFAULT_RUN_TIMEOUT_MS);
    expect(await resolver.resolve("c-1")).toBe(5000);
  });

  it("falls back to the default when the value is absent", async () => {
    const resolver = new ConfigRunTimeoutResolver(new FakeConsumerConfigResolver({}), DEFAULT_RUN_TIMEOUT_MS);
    expect(await resolver.resolve("c-1")).toBe(DEFAULT_RUN_TIMEOUT_MS);
  });

  it("falls back to the default when the value is empty", async () => {
    const resolver = new ConfigRunTimeoutResolver(new FakeConsumerConfigResolver({ runTimeoutMs: "" }), DEFAULT_RUN_TIMEOUT_MS);
    expect(await resolver.resolve("c-1")).toBe(DEFAULT_RUN_TIMEOUT_MS);
  });

  it("falls back to the default when the value is unparseable", async () => {
    const resolver = new ConfigRunTimeoutResolver(new FakeConsumerConfigResolver({ runTimeoutMs: "abc" }), DEFAULT_RUN_TIMEOUT_MS);
    expect(await resolver.resolve("c-1")).toBe(DEFAULT_RUN_TIMEOUT_MS);
  });

  it("falls back to the default when the value is non-positive", async () => {
    const resolver = new ConfigRunTimeoutResolver(new FakeConsumerConfigResolver({ runTimeoutMs: "0" }), DEFAULT_RUN_TIMEOUT_MS);
    expect(await resolver.resolve("c-1")).toBe(DEFAULT_RUN_TIMEOUT_MS);
  });

  it("resolves the timeout declared on the agent schema, defaulting to 1h when unset", async () => {
    const registry = new InMemoryConsumerRegistry();
    registry.register(new Consumer<unknown>("c-1", new TypeRule("foo"), new RecordingHandler(successfulOutcome()), AGENT_CONSUMER_CONFIG_SCHEMA, []));
    const repo = new InMemoryConsumerConfigRepository();
    const configResolver = new MergingConsumerConfigResolver(registry, repo);
    const resolver = new ConfigRunTimeoutResolver(configResolver, DEFAULT_RUN_TIMEOUT_MS);

    expect(await resolver.resolve("c-1")).toBe(DEFAULT_RUN_TIMEOUT_MS);

    await repo.set("c-1", { runTimeoutMs: "120000" });
    expect(await resolver.resolve("c-1")).toBe(120000);
  });
});
