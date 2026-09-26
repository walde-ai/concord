import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Argon2PasswordSecretDeriver,
  Consumer,
  ConsumerRegistrable,
  Credential,
  InMemoryCredentialStore,
  InMemoryEventStore,
  InMemoryRunRepository,
  MakeApp,
  SecureRemotePasswordIssuer,
  SqliteCredentialStore,
  SqliteDatabase,
  TEST_ARGON2ID_PARAMETERS,
  success,
  type Rule,
  type Handler,
  type Run,
  type Result,
  type EventHandlerError,
  type Event,
  type App,
} from "../../src/index";
import { userCreateCommand } from "../../src/cli/commands/user-create-command";
import { userDeleteCommand } from "../../src/cli/commands/user-delete-command";
import { eventEmitCommand } from "../../src/cli/commands/event-emit-command";
import { contextUpsertCommand } from "../../src/cli/commands/context-upsert-command";
import { buildUserCommandDeps } from "../../src/cli/main/compose";

interface TempDb {
  readonly path: string;
  readonly dir: string;
}

const tempDbs: TempDb[] = [];

function newTempDb(): TempDb {
  const dir = mkdtempSync(join(tmpdir(), "concord-cli-"));
  const path = join(dir, "test.db");
  const temp = { path, dir };
  tempDbs.push(temp);
  return temp;
}

afterEach(() => {
  while (tempDbs.length > 0) {
    const temp = tempDbs.pop();
    if (temp !== undefined) {
      rmSync(temp.dir, { recursive: true, force: true });
    }
  }
});

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

class CliEventRule implements Rule<unknown> {
  public decide(event: Event<unknown>): boolean {
    return event.type === "cli-event";
  }
}

class RecordingCliHandler implements Handler<unknown> {
  public readonly calls: Run<unknown>[] = [];

  public async handle(run: Run<unknown>, _signal: AbortSignal): Promise<Result<void, EventHandlerError>> {
    this.calls.push(run);
    return success<void, EventHandlerError>(undefined);
  }
}

describe("user create command", () => {
  it("persists a credential against a temp sqlite database and returns the descriptor", async () => {
    const temp = newTempDb();
    const deps = buildUserCommandDeps(temp.path, TEST_ARGON2ID_PARAMETERS);

    const descriptor = await userCreateCommand({ name: "alice", password: "secret", deps });

    expect(descriptor).toEqual({ username: "alice" });

    const verifyDb = new SqliteDatabase(temp.path);
    const verifyStore = new SqliteCredentialStore(verifyDb);
    const stored = await verifyStore.getByName("alice");
    expect(stored.username).toBe("alice");
    expect(stored.salt).toHaveLength(32);
    expect(stored.verifier).toHaveLength(512);
    expect(await verifyStore.exists("alice")).toBe(true);
    await verifyDb.close();
  });

  it("re-derivation with the same inputs produces a different salt (random salt each issue)", async () => {
    const temp = newTempDb();
    const deps = buildUserCommandDeps(temp.path, TEST_ARGON2ID_PARAMETERS);

    await userCreateCommand({ name: "bob", password: "hunter2", deps });

    const verifyDb = new SqliteDatabase(temp.path);
    const verifyStore = new SqliteCredentialStore(verifyDb);
    const stored = await verifyStore.getByName("bob");

    const deriver = new Argon2PasswordSecretDeriver(TEST_ARGON2ID_PARAMETERS);
    const issuer = new SecureRemotePasswordIssuer(deriver);
    const reference = await issuer.generate("bob", "hunter2");

    expect(stored.salt).not.toBe(reference.salt);
    expect(stored.verifier).not.toBe(reference.verifier);
    await verifyDb.close();
  });
});

describe("user delete command", () => {
  it("deletes a previously-created user and removes the credential", async () => {
    const temp = newTempDb();
    const createDeps = buildUserCommandDeps(temp.path, TEST_ARGON2ID_PARAMETERS);
    await userCreateCommand({ name: "alice", password: "secret", deps: createDeps });

    const deleteDeps = buildUserCommandDeps(temp.path, TEST_ARGON2ID_PARAMETERS);
    const result = await userDeleteCommand({ name: "alice", deps: deleteDeps });

    expect(result).toEqual({ username: "alice" });

    const verifyDb = new SqliteDatabase(temp.path);
    const verifyStore = new SqliteCredentialStore(verifyDb);
    expect(await verifyStore.exists("alice")).toBe(false);
    await verifyDb.close();
  });
});

describe("event emit command", () => {
  let app: App | null = null;

  afterEach(async () => {
    if (app !== null) {
      await app.stop();
      app = null;
    }
  });

  it("logs in, signs POST /api/events, and triggers the live consumer", async () => {
    const credentialStore = new InMemoryCredentialStore();
    const deriver = new Argon2PasswordSecretDeriver(TEST_ARGON2ID_PARAMETERS);
    const issuer = new SecureRemotePasswordIssuer(deriver);
    const issued = await issuer.generate("alice", "super-secret");
    await credentialStore.save(new Credential("alice", issued.salt, issued.verifier));

    const handler = new RecordingCliHandler();

    app = MakeApp({
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
    app.register(
      new ConsumerRegistrable(new Consumer<unknown>("recorder", new CliEventRule(), handler, [], [])),
    );
    await app.start();

    const baseUrl = resolveApiBaseUrl(app);
    const descriptor = await eventEmitCommand({
      origin: `http://${baseUrl}`,
      username: "alice",
      password: "super-secret",
      type: "cli-event",
      payload: { hello: "world" },
      argon2: TEST_ARGON2ID_PARAMETERS,
    });

    expect(descriptor.type).toBe("cli-event");
    expect(descriptor.producerId).toBe("cli");
    expect(descriptor.payload).toEqual({ hello: "world" });

    expect(handler.calls.length).toBeGreaterThanOrEqual(1);
  });
});

describe("context upsert command", () => {
  let app: App | null = null;

  afterEach(async () => {
    if (app !== null) {
      await app.stop();
      app = null;
    }
  });

  it("creates the context on first upsert and updates it on the second", async () => {
    const credentialStore = new InMemoryCredentialStore();
    const deriver = new Argon2PasswordSecretDeriver(TEST_ARGON2ID_PARAMETERS);
    const issuer = new SecureRemotePasswordIssuer(deriver);
    const issued = await issuer.generate("alice", "super-secret");
    await credentialStore.save(new Credential("alice", issued.salt, issued.verifier));

    app = MakeApp({
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
    const origin = `http://${baseUrl}`;
    const payload = { pipelineName: "writer-pipeline", region: "eu-central-1" };

    const created = await contextUpsertCommand({
      origin,
      username: "alice",
      password: "super-secret",
      name: "deploy-context",
      payload,
      secrets: { profile: "deploy-profile" },
      argon2: TEST_ARGON2ID_PARAMETERS,
    });

    expect(created.name).toBe("deploy-context");
    expect(created.payload).toEqual(payload);
    expect(created.secretNames).toEqual(["profile"]);

    const updated = await contextUpsertCommand({
      origin,
      username: "alice",
      password: "super-secret",
      name: "deploy-context",
      payload: { pipelineName: "writer-pipeline", region: "eu-central-1", account: "639966646786" },
      secrets: { profile: "deploy-profile", token: "abc" },
      argon2: TEST_ARGON2ID_PARAMETERS,
    });

    expect(updated.name).toBe("deploy-context");
    expect(updated.secretNames).toEqual(["profile", "token"]);
    expect(updated.payload).toEqual({
      pipelineName: "writer-pipeline",
      region: "eu-central-1",
      account: "639966646786",
    });
  });
});
