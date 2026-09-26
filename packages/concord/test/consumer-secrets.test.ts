import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";

import { Consumer } from "../src/domain/entities/consumer";
import type { ConsumerConfigParameter, ConsumerConfigSecretParameter } from "../src/domain/component";
import { InMemoryConsumerConfigRepository } from "../src/infra/adapters/stores/in-memory-consumer-config-repository";
import { InMemoryConsumerStateRepository } from "../src/infra/adapters/stores/in-memory-consumer-state-repository";
import { InMemoryConsumerRegistry } from "../src/infra/adapters/registry/in-memory-consumer-registry";
import { MergingConsumerConfigResolver } from "../src/infra/adapters/config/merging-consumer-config-resolver";
import { RepositoryConsumerSecretResolver } from "../src/infra/adapters/config/repository-consumer-secret-resolver";
import { ConsumerDescriptorBuilder } from "../src/domain/interactors/consumer-descriptor-builder";
import { SetConsumerSecretsInteractor } from "../src/domain/interactors/set-consumer-secrets-interactor";
import { ConsumerNotFoundError, InvalidConsumerConfigError } from "../src/domain/exceptions/errors";
import { AGENT_GITHUB_TOKEN_SECRET } from "../src/infra/adapters/consumers/agents/agent-config-schema";
import { ConsumerGitHubClientResolver } from "../src/infra/adapters/consumers/agents/consumer-github-client-resolver";
import { OctokitGitHubClientFactory } from "../src/infra/adapters/producers/github/github-client-factory";
import type { GitHubClient } from "../src/infra/adapters/producers/github/github-client";
import { SqliteDatabase } from "../src/infra/adapters/stores/sqlite/sqlite-database";
import { SqliteConsumerConfigRepository } from "../src/infra/adapters/stores/sqlite/sqlite-consumer-config-repository";
import { TypeRule, RecordingHandler, successfulOutcome } from "./helpers";
import { RecordingGitHubClient } from "./fakes";

const SCHEMA: readonly ConsumerConfigParameter[] = [
  { key: "modelId", label: "Model", required: true, defaultValue: "" },
];
const SECRET_SCHEMA: readonly ConsumerConfigSecretParameter[] = AGENT_GITHUB_TOKEN_SECRET;

function makeConsumer(secretSchema: readonly ConsumerConfigSecretParameter[] = SECRET_SCHEMA): Consumer<unknown> {
  return new Consumer<unknown>("c-1", new TypeRule("foo"), new RecordingHandler(successfulOutcome()), SCHEMA, secretSchema);
}

describe("InMemoryConsumerConfigRepository secrets", () => {
  it("round-trips a secrets map", async () => {
    const repo = new InMemoryConsumerConfigRepository();
    expect(await repo.getSecrets("c-1")).toEqual({});
    await repo.applySecretOperation("c-1", { upserts: [{ name: "githubToken", value: "tok-1" }], deletes: [] });
    expect(await repo.getSecrets("c-1")).toEqual({ githubToken: "tok-1" });
  });

  it("upsert adds a new secret and overwrites an existing one without touching values", async () => {
    const repo = new InMemoryConsumerConfigRepository();
    await repo.set("c-1", { modelId: "a/b" });
    await repo.applySecretOperation("c-1", { upserts: [{ name: "githubToken", value: "tok-1" }], deletes: [] });
    await repo.applySecretOperation("c-1", { upserts: [{ name: "githubToken", value: "tok-2" }], deletes: [] });
    expect(await repo.getSecrets("c-1")).toEqual({ githubToken: "tok-2" });
    expect(await repo.get("c-1")).toEqual({ modelId: "a/b" });
  });

  it("delete removes the named secret and is a silent no-op for a missing name", async () => {
    const repo = new InMemoryConsumerConfigRepository();
    await repo.applySecretOperation("c-1", { upserts: [{ name: "githubToken", value: "tok-1" }], deletes: [] });
    await repo.applySecretOperation("c-1", { upserts: [], deletes: ["missing"] });
    expect(await repo.getSecrets("c-1")).toEqual({ githubToken: "tok-1" });
    await repo.applySecretOperation("c-1", { upserts: [], deletes: ["githubToken"] });
    expect(await repo.getSecrets("c-1")).toEqual({});
  });

  it("mixed operation applies both upserts and deletes", async () => {
    const repo = new InMemoryConsumerConfigRepository();
    await repo.applySecretOperation("c-1", { upserts: [{ name: "githubToken", value: "tok-1" }], deletes: [] });
    await repo.applySecretOperation("c-1", {
      upserts: [{ name: "githubToken", value: "tok-2" }],
      deletes: [],
    });
    await repo.applySecretOperation("c-1", {
      upserts: [],
      deletes: ["githubToken"],
    });
    expect(await repo.getSecrets("c-1")).toEqual({});
  });

  it("set of values preserves previously-applied secrets", async () => {
    const repo = new InMemoryConsumerConfigRepository();
    await repo.applySecretOperation("c-1", { upserts: [{ name: "githubToken", value: "tok-1" }], deletes: [] });
    await repo.set("c-1", { modelId: "c/d" });
    expect(await repo.getSecrets("c-1")).toEqual({ githubToken: "tok-1" });
    expect(await repo.get("c-1")).toEqual({ modelId: "c/d" });
  });
});

describe("RepositoryConsumerSecretResolver", () => {
  it("returns the persisted map", async () => {
    const registry = new InMemoryConsumerRegistry();
    registry.register(makeConsumer());
    const repo = new InMemoryConsumerConfigRepository();
    await repo.applySecretOperation("c-1", { upserts: [{ name: "githubToken", value: "tok-1" }], deletes: [] });
    const resolver = new RepositoryConsumerSecretResolver(registry, repo);
    expect(await resolver.resolveSecrets("c-1")).toEqual({ githubToken: "tok-1" });
  });

  it("returns an empty map for a schema-less consumer", async () => {
    const registry = new InMemoryConsumerRegistry();
    registry.register(makeConsumer([]));
    const repo = new InMemoryConsumerConfigRepository();
    await repo.applySecretOperation("c-1", { upserts: [{ name: "githubToken", value: "tok-1" }], deletes: [] });
    const resolver = new RepositoryConsumerSecretResolver(registry, repo);
    expect(await resolver.resolveSecrets("c-1")).toEqual({});
  });

  it("reflects an edited map on the next call without reconstruction", async () => {
    const registry = new InMemoryConsumerRegistry();
    registry.register(makeConsumer());
    const repo = new InMemoryConsumerConfigRepository();
    const resolver = new RepositoryConsumerSecretResolver(registry, repo);
    expect(await resolver.resolveSecrets("c-1")).toEqual({});
    await repo.applySecretOperation("c-1", { upserts: [{ name: "githubToken", value: "tok-1" }], deletes: [] });
    expect(await resolver.resolveSecrets("c-1")).toEqual({ githubToken: "tok-1" });
  });
});

describe("ConsumerDescriptorBuilder secret enrichment", () => {
  function setup(secretSchema: readonly ConsumerConfigSecretParameter[] = SECRET_SCHEMA): {
    readonly builder: ConsumerDescriptorBuilder;
    readonly repo: InMemoryConsumerConfigRepository;
  } {
    const registry = new InMemoryConsumerRegistry();
    registry.register(makeConsumer(secretSchema));
    const states = new InMemoryConsumerStateRepository();
    const repo = new InMemoryConsumerConfigRepository();
    const configResolver = new MergingConsumerConfigResolver(registry, repo);
    const secretResolver = new RepositoryConsumerSecretResolver(registry, repo);
    return {
      builder: new ConsumerDescriptorBuilder(registry, states, configResolver, secretResolver),
      repo,
    };
  }

  it("returns secretParameters from the schema and sorted secretNames from persisted secrets", async () => {
    const { builder, repo } = setup();
    await repo.applySecretOperation("c-1", { upserts: [{ name: "githubToken", value: "tok-1" }], deletes: [] });
    const descriptor = await builder.build("c-1");
    expect(descriptor.secretParameters).toEqual(SECRET_SCHEMA);
    expect(descriptor.secretNames).toEqual(["githubToken"]);
  });

  it("does not include secret values in the descriptor body", async () => {
    const { builder, repo } = setup();
    await repo.applySecretOperation("c-1", { upserts: [{ name: "githubToken", value: "tok-1" }], deletes: [] });
    const descriptor = await builder.build("c-1");
    const serialized = JSON.stringify(descriptor);
    expect(serialized).not.toContain("tok-1");
  });
});

describe("SetConsumerSecretsInteractor", () => {
  function setup(secretSchema: readonly ConsumerConfigSecretParameter[] = SECRET_SCHEMA): {
    readonly interactor: SetConsumerSecretsInteractor;
    readonly repo: InMemoryConsumerConfigRepository;
  } {
    const registry = new InMemoryConsumerRegistry();
    registry.register(makeConsumer(secretSchema));
    const states = new InMemoryConsumerStateRepository();
    const repo = new InMemoryConsumerConfigRepository();
    const configResolver = new MergingConsumerConfigResolver(registry, repo);
    const secretResolver = new RepositoryConsumerSecretResolver(registry, repo);
    const builder = new ConsumerDescriptorBuilder(registry, states, configResolver, secretResolver);
    return {
      interactor: new SetConsumerSecretsInteractor(registry, repo, builder),
      repo,
    };
  }

  it("persists an upsert and returns the enriched descriptor", async () => {
    const { interactor } = setup();
    const descriptor = await interactor.set("c-1", {
      upserts: [{ name: "githubToken", value: "tok-1" }],
      deletes: [],
    });
    expect(descriptor.secretNames).toEqual(["githubToken"]);
  });

  it("rejects an upsert name not in the schema with InvalidConsumerConfigError", async () => {
    const { interactor } = setup();
    await expect(
      interactor.set("c-1", { upserts: [{ name: "unknown", value: "x" }], deletes: [] }),
    ).rejects.toBeInstanceOf(InvalidConsumerConfigError);
  });

  it("rejects a delete name not in the schema with InvalidConsumerConfigError", async () => {
    const { interactor } = setup();
    await expect(
      interactor.set("c-1", { upserts: [], deletes: ["unknown"] }),
    ).rejects.toBeInstanceOf(InvalidConsumerConfigError);
  });

  it("rejects an unknown consumer id with ConsumerNotFoundError", async () => {
    const { interactor } = setup();
    await expect(
      interactor.set("missing", { upserts: [{ name: "githubToken", value: "x" }], deletes: [] }),
    ).rejects.toBeInstanceOf(ConsumerNotFoundError);
  });
});

describe("ConsumerGitHubClientResolver", () => {
  class RecordingFactory implements InstanceType<typeof OctokitGitHubClientFactory> {
    public readonly tokens: string[] = [];
    public create(token: string): GitHubClient {
      this.tokens.push(token);
      return new RecordingGitHubClient();
    }
  }

  it("returns a client built from the token and the raw token when githubToken is present", async () => {
    const registry = new InMemoryConsumerRegistry();
    registry.register(makeConsumer());
    const repo = new InMemoryConsumerConfigRepository();
    await repo.applySecretOperation("c-1", { upserts: [{ name: "githubToken", value: "tok-123" }], deletes: [] });
    const secretResolver = new RepositoryConsumerSecretResolver(registry, repo);
    const factory = new RecordingFactory();
    const defaultClient = new RecordingGitHubClient();
    const resolver = new ConsumerGitHubClientResolver(secretResolver, factory, defaultClient);

    const identity = await resolver.resolve("c-1");
    expect(identity.token).toBe("tok-123");
    expect(factory.tokens).toEqual(["tok-123"]);
    expect(identity.client).not.toBe(defaultClient);
  });

  it("returns the default client and null token when no githubToken is present", async () => {
    const registry = new InMemoryConsumerRegistry();
    registry.register(makeConsumer());
    const repo = new InMemoryConsumerConfigRepository();
    const secretResolver = new RepositoryConsumerSecretResolver(registry, repo);
    const factory = new RecordingFactory();
    const defaultClient = new RecordingGitHubClient();
    const resolver = new ConsumerGitHubClientResolver(secretResolver, factory, defaultClient);

    const identity = await resolver.resolve("c-1");
    expect(identity.token).toBeNull();
    expect(identity.client).toBe(defaultClient);
    expect(factory.tokens).toEqual([]);
  });
});

describe("SqliteConsumerConfigRepository secrets", () => {
  function makeRepo(path: string): SqliteConsumerConfigRepository {
    return new SqliteConsumerConfigRepository(new SqliteDatabase(path));
  }

  it("round-trips a secrets map", async () => {
    const path = join(tmpdir(), `concord-secrets-${Date.now()}-${Math.random()}.db`);
    const repo = makeRepo(path);
    await repo.applySecretOperation("c-1", { upserts: [{ name: "githubToken", value: "tok-1" }], deletes: [] });
    expect(await repo.getSecrets("c-1")).toEqual({ githubToken: "tok-1" });
  });

  it("upsert overwrites a single secret while leaving others and values intact", async () => {
    const path = join(tmpdir(), `concord-secrets-${Date.now()}-${Math.random()}.db`);
    const repo = makeRepo(path);
    await repo.set("c-1", { modelId: "a/b" });
    await repo.applySecretOperation("c-1", { upserts: [{ name: "githubToken", value: "tok-1" }], deletes: [] });
    await repo.applySecretOperation("c-1", { upserts: [{ name: "githubToken", value: "tok-2" }], deletes: [] });
    expect(await repo.getSecrets("c-1")).toEqual({ githubToken: "tok-2" });
    expect(await repo.get("c-1")).toEqual({ modelId: "a/b" });
  });

  it("set of values leaves the secrets intact", async () => {
    const path = join(tmpdir(), `concord-secrets-${Date.now()}-${Math.random()}.db`);
    const repo = makeRepo(path);
    await repo.applySecretOperation("c-1", { upserts: [{ name: "githubToken", value: "tok-1" }], deletes: [] });
    await repo.set("c-1", { modelId: "c/d" });
    expect(await repo.getSecrets("c-1")).toEqual({ githubToken: "tok-1" });
    expect(await repo.get("c-1")).toEqual({ modelId: "c/d" });
  });

  it("migrates a database created by the previous version adding the secrets_json column non-destructively", async () => {
    const dir = join(tmpdir(), `concord-migrate-${Date.now()}-${Math.random()}`);
    mkdirSync(dir, { recursive: true });
    const dbPath = join(dir, "concord.db");
    // Simulate a pre-migration database: create the table WITHOUT secrets_json
    const oldSchema = `
      CREATE TABLE consumer_configs (
        version TEXT NOT NULL,
        consumer_id TEXT PRIMARY KEY,
        values_json TEXT NOT NULL DEFAULT '{}'
      );
    `;
    writeFileSync(dbPath, "");
    // Use better-sqlite3 directly to create the old-format table and seed a row
    const Database = (await import("better-sqlite3")).default;
    const raw = new Database(dbPath);
    raw.exec(oldSchema);
    raw.prepare(
      "INSERT INTO consumer_configs (version, consumer_id, values_json) VALUES (?, ?, ?)",
    ).run("v1", "c-old", JSON.stringify({ modelId: "old/model" }));
    raw.close();

    // Opening with the new SqliteDatabase runs the migration
    const repo = makeRepo(dbPath);
    // Previously stored values are intact
    expect(await repo.get("c-old")).toEqual({ modelId: "old/model" });
    // Secrets column exists and defaults to empty
    expect(await repo.getSecrets("c-old")).toEqual({});
    // Writing secrets works and does not clobber values
    await repo.applySecretOperation("c-old", { upserts: [{ name: "githubToken", value: "tok-1" }], deletes: [] });
    expect(await repo.getSecrets("c-old")).toEqual({ githubToken: "tok-1" });
    expect(await repo.get("c-old")).toEqual({ modelId: "old/model" });

    rmSync(dir, { recursive: true, force: true });
  });
});
