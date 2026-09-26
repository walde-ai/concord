import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import Database from "better-sqlite3";

import { Event } from "../src/domain/entities/event";
import { Run, RunFailure } from "../src/domain/entities/run";
import { RunForm } from "../src/domain/entities/run-form";
import { RunUpdate } from "../src/domain/entities/run-update";
import { EventNotFoundError, RunNotFoundError, FormNotFoundError } from "../src/domain/exceptions/errors";
import { Context } from "../src/domain/entities/context";
import { SqliteDatabase } from "../src/infra/adapters/stores/sqlite/sqlite-database";
import { SqliteEventStore } from "../src/infra/adapters/stores/sqlite/sqlite-event-store";
import { SqliteRunRepository } from "../src/infra/adapters/stores/sqlite/sqlite-run-repository";
import { SqliteProducerStateRepository } from "../src/infra/adapters/stores/sqlite/sqlite-producer-state-repository";
import { SqliteConsumerStateRepository } from "../src/infra/adapters/stores/sqlite/sqlite-consumer-state-repository";
import { SqliteContextStore } from "../src/infra/adapters/stores/sqlite/sqlite-context-store";
import { SqliteCredentialStore } from "../src/infra/adapters/stores/sqlite/sqlite-credential-store";
import { SqlitePauseStateRepository } from "../src/infra/adapters/stores/sqlite/sqlite-pause-state-repository";
import { SqliteFormRepository } from "../src/infra/adapters/stores/sqlite/sqlite-form-repository";
import { SqliteRunUpdateRepository } from "../src/infra/adapters/stores/sqlite/sqlite-run-update-repository";
import { SqliteSessionStore } from "../src/infra/adapters/stores/sqlite/sqlite-session-store";
import { SqlitePullRequestLifecycleStore } from "../src/infra/adapters/stores/sqlite/sqlite-pull-request-lifecycle-store";
import { SqlitePersistenceFactory } from "../src/infra/adapters/stores/sqlite/sqlite-persistence-factory";
import { EventV1 } from "../src/infra/adapters/stores/sqlite/dto/event-v1";
import { RunV1 } from "../src/infra/adapters/stores/sqlite/dto/run-v1";
import { FormV1 } from "../src/infra/adapters/stores/sqlite/dto/form-v1";
import { RunUpdateV1 } from "../src/infra/adapters/stores/sqlite/dto/run-update-v1";
import { ContextV1 } from "../src/infra/adapters/stores/sqlite/dto/context-v1";
import { CredentialV1 } from "../src/infra/adapters/stores/sqlite/dto/credential-v1";
import { SessionV1 } from "../src/infra/adapters/stores/sqlite/dto/session-v1";
import { Credential } from "../src/domain/entities/credential";
import { ContextNotFoundError, UserNotFoundError, SessionExpiredError } from "../src/domain/exceptions/errors";
import type { PrLifecycleState } from "../src/infra/adapters/producers/github/pull-request-lifecycle-store";
import { MakeApp } from "../src/infra/main/make-app";
import { InMemoryEventStore } from "../src/infra/adapters/stores/in-memory-event-store";
import { Consumer } from "../src/domain/entities/consumer";
import { ConsumerRegistrable } from "../src/infra/adapters/consumers/consumer-registrable";
import {
  FakeProducer,
  FixedClock,
  RecordingHandler,
  SequentialIdGenerator,
  TypeRule,
  successfulOutcome,
} from "./helpers";

interface TempDb {
  readonly path: string;
  readonly dir: string;
}

function createTempDb(): TempDb {
  const dir = mkdtempSync(join(tmpdir(), "concord-sqlite-"));
  const path = join(dir, "test.db");
  return { path, dir };
}

function cleanupTempDb(temp: TempDb): void {
  rmSync(temp.dir, { recursive: true, force: true });
}

const tempDbs: TempDb[] = [];

afterEach(() => {
  while (tempDbs.length > 0) {
    const temp = tempDbs.pop();
    if (temp !== undefined) {
      cleanupTempDb(temp);
    }
  }
});

function newTempDb(): TempDb {
  const temp = createTempDb();
  tempDbs.push(temp);
  return temp;
}

describe("sqlite event store", () => {
  it("round-trips an event through save and getById preserving every field", async () => {
    const temp = newTempDb();
    const database = new SqliteDatabase(temp.path);
    const store = new SqliteEventStore(database);

    const original = new Event<unknown>(
      "evt-1",
      "producer-a",
      "pevt-1",
      new Date("2026-07-04T12:34:56.789Z"),
      "foo",
      { n: 1, nested: { ok: true } },
    );

    const saveResult = await store.save(original);
    expect(saveResult.ok).toBe(true);

    const restored = await store.getById("evt-1");

    expect(restored.id).toBe("evt-1");
    expect(restored.producerId).toBe("producer-a");
    expect(restored.datetime.toISOString()).toBe("2026-07-04T12:34:56.789Z");
    expect(restored.type).toBe("foo");
    expect(restored.payload).toEqual({ n: 1, nested: { ok: true } });

    await database.close();
  });

  it("throws EventNotFoundError when an event id is absent", async () => {
    const temp = newTempDb();
    const database = new SqliteDatabase(temp.path);
    const store = new SqliteEventStore(database);

    await expect(store.getById("missing")).rejects.toBeInstanceOf(EventNotFoundError);

    await database.close();
  });
});

describe("sqlite run repository", () => {
  it("round-trips a run with its embedded event and supports upsert on state change", async () => {
    const temp = newTempDb();
    const database = new SqliteDatabase(temp.path);
    const eventStore = new SqliteEventStore(database);
    const runRepository = new SqliteRunRepository(database);

    const event = new Event<unknown>("evt-1", "p-1", "pevt-1", new Date("2026-07-04T00:00:00Z"), "foo", { x: 1 });
    await eventStore.save(event);

    const run = new Run<unknown>("run-1", event, "c-1", "RUNNING");
    await runRepository.save(run);

    const restored = await runRepository.getById("run-1");
    expect(restored.id).toBe("run-1");
    expect(restored.state).toBe("RUNNING");
    expect(restored.event.id).toBe("evt-1");
    expect(restored.event.type).toBe("foo");
    expect(restored.event.payload).toEqual({ x: 1 });

    const succeeded = new Run<unknown>("run-1", event, "c-1", "SUCCEEDED");
    await runRepository.save(succeeded);
    const updated = await runRepository.getById("run-1");
    expect(updated.state).toBe("SUCCEEDED");

    await database.close();
  });

  it("throws RunNotFoundError when a run id is absent", async () => {
    const temp = newTempDb();
    const database = new SqliteDatabase(temp.path);
    const runRepository = new SqliteRunRepository(database);

    await expect(runRepository.getById("missing")).rejects.toBeInstanceOf(RunNotFoundError);

    await database.close();
  });

  it("round-trips a failed run with its failure debug info", async () => {
    const temp = newTempDb();
    const database = new SqliteDatabase(temp.path);
    const eventStore = new SqliteEventStore(database);
    const runRepository = new SqliteRunRepository(database);

    const event = new Event<unknown>("evt-1", "p-1", "pevt-1", new Date("2026-07-04T00:00:00Z"), "foo", { x: 1 });
    await eventStore.save(event);

    const failure = new RunFailure("EventHandlerError", "No repo entry for example-corp/app", "stack-trace-line");
    const run = new Run<unknown>("run-failed", event, "c-1", "FAILED", failure);
    await runRepository.save(run);

    const restored = await runRepository.getById("run-failed");
    expect(restored.state).toBe("FAILED");
    expect(restored.failure).not.toBeNull();
    expect(restored.failure?.errorName).toBe("EventHandlerError");
    expect(restored.failure?.message).toBe("No repo entry for example-corp/app");
    expect(restored.failure?.stack).toBe("stack-trace-line");

    await database.close();
  });

  it("migrates a legacy runs table without the failure column", async () => {
    const temp = newTempDb();
    const dir = dirname(temp.path);

    const legacy = new Database(temp.path);
    legacy.exec(`
      CREATE TABLE events (
        version TEXT NOT NULL,
        id TEXT PRIMARY KEY,
        producer_id TEXT NOT NULL,
        producer_event_id TEXT NOT NULL DEFAULT '',
        datetime TEXT NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        muted INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE runs (
        version TEXT NOT NULL,
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL,
        consumer_id TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL,
        FOREIGN KEY (event_id) REFERENCES events(id)
      );
    `);
    legacy.prepare(
      "INSERT INTO events (version, id, producer_id, producer_event_id, datetime, type, payload, muted) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("v1", "evt-1", "p-1", "pevt-1", "2026-07-04T00:00:00Z", "foo", "{}", 0);
    legacy.prepare(
      "INSERT INTO runs (version, id, event_id, consumer_id, state) VALUES (?, ?, ?, ?, ?)",
    ).run("v1", "run-legacy", "evt-1", "c-1", "FAILED");
    legacy.close();

    const database = new SqliteDatabase(temp.path);
    const eventStore = new SqliteEventStore(database);
    const runRepository = new SqliteRunRepository(database);

    const restored = await runRepository.getById("run-legacy");
    expect(restored.state).toBe("FAILED");
    expect(restored.failure).toBeNull();

    const event = await eventStore.getById("evt-1");
    const failure = new RunFailure("EventHandlerError", "boom", null);
    const updated = new Run<unknown>("run-legacy", event, "c-1", "FAILED", failure);
    await runRepository.save(updated);

    const repopulated = await runRepository.getById("run-legacy");
    expect(repopulated.failure?.message).toBe("boom");

    await database.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("sqlite form repository", () => {
  it("round-trips a pending form with its definition and supports upsert on answer", async () => {
    const temp = newTempDb();
    const database = new SqliteDatabase(temp.path);
    const formRepository = new SqliteFormRepository(database);

    const createdAt = new Date("2026-07-06T09:00:00Z");
    const form = new RunForm(
      "form-1",
      "run-1",
      "c-1",
      1,
      "Pick a strategy",
      [
        { key: "plan", label: "Plan", inputType: "select", options: ["A", "B"], allowOther: true, defaultValue: "A" },
        { key: "tags", label: "Tags", inputType: "checkbox", options: ["x", "y"], allowOther: false, defaultValue: ["x"] },
        { key: "note", label: "Note", inputType: "textarea", defaultValue: "hi" },
      ],
      "PENDING",
      null,
      createdAt,
    );
    await formRepository.save(form);

    const restored = await formRepository.getById("form-1");
    expect(restored.runId).toBe("run-1");
    expect(restored.consumerId).toBe("c-1");
    expect(restored.round).toBe(1);
    expect(restored.status).toBe("PENDING");
    expect(restored.answers).toBeNull();
    expect(restored.prompt).toBe("Pick a strategy");
    expect(restored.fields).toHaveLength(3);
    expect(restored.fields[0]).toEqual(form.fields[0]);
    expect(restored.fields[1]).toEqual(form.fields[1]);
    expect(restored.fields[2]).toEqual(form.fields[2]);
    expect(restored.answeredAt).toBeNull();

    const answeredAt = new Date("2026-07-06T09:05:00Z");
    form.markAnswered({ plan: "B", tags: ["x", "y"], note: "ok" }, answeredAt);
    await formRepository.save(form);
    const updated = await formRepository.getById("form-1");
    expect(updated.status).toBe("ANSWERED");
    expect(updated.answers).toEqual({ plan: "B", tags: ["x", "y"], note: "ok" });
    expect(updated.answeredAt).toEqual(answeredAt);

    await database.close();
  });

  it("throws FormNotFoundError when a form id is absent", async () => {
    const temp = newTempDb();
    const database = new SqliteDatabase(temp.path);
    const formRepository = new SqliteFormRepository(database);

    await expect(formRepository.getById("missing")).rejects.toBeInstanceOf(FormNotFoundError);

    await database.close();
  });

  it("listByRun returns forms ordered by ascending round and counts them", async () => {
    const temp = newTempDb();
    const database = new SqliteDatabase(temp.path);
    const formRepository = new SqliteFormRepository(database);

    await formRepository.save(makeForm("form-2", "run-1", 2));
    await formRepository.save(makeForm("form-1", "run-1", 1));
    await formRepository.save(makeForm("form-other", "run-2", 1));

    const list = await formRepository.listByRun("run-1");
    expect(list.map((f) => f.id)).toEqual(["form-1", "form-2"]);
    expect(await formRepository.countByRun("run-1")).toBe(2);
    expect(await formRepository.countByRun("run-2")).toBe(1);
    expect(await formRepository.countByRun("run-empty")).toBe(0);

    await database.close();
  });

  it("getPendingByRun returns the pending form and null after it is answered", async () => {
    const temp = newTempDb();
    const database = new SqliteDatabase(temp.path);
    const formRepository = new SqliteFormRepository(database);

    const form = makeForm("form-1", "run-1", 1);
    await formRepository.save(form);

    const pending = await formRepository.getPendingByRun("run-1");
    expect(pending?.id).toBe("form-1");

    form.markAnswered({ note: "ok" }, new Date("2026-07-06T09:05:00Z"));
    await formRepository.save(form);

    const after = await formRepository.getPendingByRun("run-1");
    expect(after).toBeNull();

    await database.close();
  });

  it("writes the v1 version tag for each form row", async () => {
    const temp = newTempDb();
    const database = new SqliteDatabase(temp.path);
    const formRepository = new SqliteFormRepository(database);

    await formRepository.save(makeForm("form-1", "run-1", 1));
    const row = database.prepare("SELECT version FROM run_forms WHERE id = ?").get("form-1") as { version: string };
    expect(row.version).toBe(FormV1.version);

    await database.close();
  });

  it("preserves a free-text field placeholder across save and read", async () => {
    const temp = newTempDb();
    const database = new SqliteDatabase(temp.path);
    const formRepository = new SqliteFormRepository(database);

    const form = new RunForm(
      "form-ph",
      "run-1",
      "c-1",
      1,
      "What now?",
      [{ key: "json", label: "JSON", inputType: "textarea", defaultValue: "", placeholder: '{ "eventId": "x" }' }],
      "PENDING",
      null,
      new Date("2026-07-06T09:00:00Z"),
    );
    await formRepository.save(form);

    const restored = await formRepository.getById("form-ph");
    const field = restored.fields[0];
    if (field.inputType !== "textarea") {
      throw new Error(`expected textarea, got ${field.inputType}`);
    }
    expect(field.placeholder).toBe('{ "eventId": "x" }');

    await database.close();
  });

  it("preserves the form context across save and read", async () => {
    const temp = newTempDb();
    const database = new SqliteDatabase(temp.path);
    const formRepository = new SqliteFormRepository(database);

    const form = new RunForm(
      "form-ctx",
      "run-1",
      "c-1",
      1,
      "Which approach?",
      [{ key: "plan", label: "Plan", inputType: "select", options: ["A", "B"], allowOther: false, defaultValue: "A" }],
      "PENDING",
      null,
      new Date("2026-07-06T09:00:00Z"),
      null,
      "## Analysis\nThe read path leaks an S3 URL.",
    );
    await formRepository.save(form);

    const restored = await formRepository.getById("form-ctx");
    expect(restored.context).toBe("## Analysis\nThe read path leaks an S3 URL.");

    await database.close();
  });

  it("exposes the form repository on the persistence bundle", async () => {
    const temp = newTempDb();
    const factory = new SqlitePersistenceFactory(temp.path);
    const bundle = factory.create();
    expect(bundle.formRepository).toBeDefined();
    await bundle.formRepository.save(makeForm("form-1", "run-1", 1));
    const restored = await bundle.formRepository.getById("form-1");
    expect(restored.runId).toBe("run-1");
    await bundle.database.close();
  });
});

function makeForm(id: string, runId: string, round: number): RunForm {
  return new RunForm(
    id,
    runId,
    "c-1",
    round,
    "What now?",
    [{ key: "note", label: "Note", inputType: "text", defaultValue: "" }],
    "PENDING",
    null,
    new Date("2026-07-06T09:00:00Z"),
  );
}

describe("sqlite persistence across connections", () => {
  it("persists data on disk so a fresh connection can read it back", async () => {
    const temp = newTempDb();

    const firstDb = new SqliteDatabase(temp.path);
    const firstEvents = new SqliteEventStore(firstDb);
    const firstRuns = new SqliteRunRepository(firstDb);

    const event = new Event<unknown>("evt-1", "p-1", "pevt-1", new Date("2026-07-04T01:02:03Z"), "foo", { k: "v" });
    await firstEvents.save(event);
    const run = new Run<unknown>("run-1", event, "c-1", "SUCCEEDED");
    await firstRuns.save(run);

    await firstDb.close();

    const secondDb = new SqliteDatabase(temp.path);
    const secondEvents = new SqliteEventStore(secondDb);
    const secondRuns = new SqliteRunRepository(secondDb);

    const restoredEvent = await secondEvents.getById("evt-1");
    expect(restoredEvent.id).toBe("evt-1");
    expect(restoredEvent.payload).toEqual({ k: "v" });

    const restoredRun = await secondRuns.getById("run-1");
    expect(restoredRun.id).toBe("run-1");
    expect(restoredRun.state).toBe("SUCCEEDED");
    expect(restoredRun.event.id).toBe("evt-1");

    await secondDb.close();
  });
});

describe("MakeApp with default sqlite persistence", () => {
  it("wires sqlite by default and manages the connection lifecycle on stop", async () => {
    const temp = newTempDb();
    const idGenerator = new SequentialIdGenerator();
    const clock = new FixedClock(new Date("2026-07-04T00:00:00Z"));

    const handler = new RecordingHandler(successfulOutcome());

    const app = MakeApp({
      databasePath: temp.path,
      idGenerator,
      clock,
    });

    app.register(
      new ConsumerRegistrable(new Consumer<unknown>("c-1", new TypeRule("foo"), handler, [], [])),
    );

    const event = new Event<unknown>("evt-1", "p-1", "pevt-1", clock.now(), "foo", { n: 1 });
    app.register(new FakeProducer("p-1", [event]));

    await app.start();

    expect(handler.calls).toHaveLength(1);
    const runId = handler.calls[0].id;

    const runRepository = new SqliteRunRepository(new SqliteDatabase(temp.path));
    const persisted = await runRepository.getById(runId);
    expect(persisted.state).toBe("SUCCEEDED");

    await app.stop();
  });
});

describe("SqlitePersistenceFactory default path", () => {
  it("resolves a .concord/concord.db path relative to cwd and creates the folder", () => {
    const factory = new SqlitePersistenceFactory();

    const expected = join(process.cwd(), ".concord", "concord.db");
    expect(factory.filePath).toBe(expected);
    expect(factory.filePath.endsWith(join(".concord", "concord.db"))).toBe(true);

    const bundle = factory.create();
    expect(existsSync(expected)).toBe(true);
    expect(existsSync(join(process.cwd(), ".concord"))).toBe(true);

    bundle.database.close();
    rmSync(join(process.cwd(), ".concord"), { recursive: true, force: true });
  });
});

describe("InMemoryEventStore getById parity", () => {
  it("implements getById to satisfy the extended EventStore port", async () => {
    const store = new InMemoryEventStore();
    const event = new Event<unknown>("evt-1", "p-1", "pevt-1", new Date("2026-07-04T00:00:00Z"), "foo", { a: 1 });
    await store.save(event);

    const restored = await store.getById("evt-1");
    expect(restored).toBe(event);

    await expect(store.getById("missing")).rejects.toBeInstanceOf(EventNotFoundError);
  });
});

describe("version tag storage and resolution", () => {
  it("writes the v1 version tag to every row and reads the rows back correctly", async () => {
    const temp = newTempDb();
    const database = new SqliteDatabase(temp.path);
    const eventStore = new SqliteEventStore(database);
    const runRepository = new SqliteRunRepository(database);

    const event = new Event<unknown>("evt-1", "p-1", "pevt-1", new Date("2026-07-04T00:00:00Z"), "foo", { v: 9 });
    await eventStore.save(event);
    const run = new Run<unknown>("run-1", event, "c-1", "FAILED");
    await runRepository.save(run);

    const eventRow = database.prepare(
      "SELECT version FROM events WHERE id = ?",
    ).get("evt-1") as { version: string };
    const runRow = database.prepare(
      "SELECT version FROM runs WHERE id = ?",
    ).get("run-1") as { version: string };

    expect(eventRow.version).toBe(EventV1.version);
    expect(runRow.version).toBe(RunV1.version);

    const restoredEvent = await eventStore.getById("evt-1");
    expect(restoredEvent.payload).toEqual({ v: 9 });
    const restoredRun = await runRepository.getById("run-1");
    expect(restoredRun.state).toBe("FAILED");

    await database.close();
  });
});

describe("sqlite event store list", () => {
  it("lists events most-recent-first with correct totals and pagination", async () => {
    const temp = newTempDb();
    const database = new SqliteDatabase(temp.path);
    const store = new SqliteEventStore(database);

    const events = [
      new Event<unknown>("evt-1", "p-1", "pevt-1", new Date("2026-07-01T00:00:00Z"), "foo", { n: 1 }),
      new Event<unknown>("evt-2", "p-1", "pevt-2", new Date("2026-07-03T00:00:00Z"), "foo", { n: 2 }),
      new Event<unknown>("evt-3", "p-1", "pevt-3", new Date("2026-07-02T00:00:00Z"), "foo", { n: 3 }),
    ];
    for (const event of events) {
      await store.save(event);
    }

    const firstPage = await store.list({ limit: 2, offset: 0 });
    expect(firstPage.total).toBe(3);
    expect(firstPage.items.map((item) => item.id)).toEqual(["evt-2", "evt-3"]);

    const secondPage = await store.list({ limit: 2, offset: 2 });
    expect(secondPage.items.map((item) => item.id)).toEqual(["evt-1"]);

    await database.close();
  });
});

describe("sqlite run repository list", () => {
  it("lists runs most-recent-first by event datetime with correct totals", async () => {
    const temp = newTempDb();
    const database = new SqliteDatabase(temp.path);
    const eventStore = new SqliteEventStore(database);
    const runRepository = new SqliteRunRepository(database);

    const eventA = new Event<unknown>("evt-a", "p-1", "pevt-a", new Date("2026-07-01T00:00:00Z"), "foo", {});
    const eventB = new Event<unknown>("evt-b", "p-1", "pevt-b", new Date("2026-07-03T00:00:00Z"), "foo", {});
    await eventStore.save(eventA);
    await eventStore.save(eventB);

    await runRepository.save(new Run("run-1", eventA, "c-1", "SUCCEEDED"));
    await runRepository.save(new Run("run-2", eventB, "c-1", "FAILED"));

    const result = await runRepository.list({ limit: 50, offset: 0 });
    expect(result.total).toBe(2);
    expect(result.items.map((item) => item.id)).toEqual(["run-2", "run-1"]);

    await database.close();
  });

  it("lists runs by event id with correct totals", async () => {
    const temp = newTempDb();
    const database = new SqliteDatabase(temp.path);
    const eventStore = new SqliteEventStore(database);
    const runRepository = new SqliteRunRepository(database);

    const eventA = new Event<unknown>("evt-a", "p-1", "pevt-a", new Date("2026-07-01T00:00:00Z"), "foo", {});
    const eventB = new Event<unknown>("evt-b", "p-1", "pevt-b", new Date("2026-07-03T00:00:00Z"), "foo", {});
    await eventStore.save(eventA);
    await eventStore.save(eventB);

    await runRepository.save(new Run("run-1", eventA, "c-1", "SUCCEEDED"));
    await runRepository.save(new Run("run-2", eventB, "c-1", "FAILED"));
    await runRepository.save(new Run("run-3", eventA, "c-1", "FAILED"));

    const result = await runRepository.listByEventId("evt-a", { limit: 50, offset: 0 });
    expect(result.total).toBe(2);
    expect(result.items.map((item) => item.id)).toEqual(["run-3", "run-1"]);

    await database.close();
  });
});

describe("sqlite producer and consumer state repositories", () => {
  it("round-trips, overwrites, and survives a fresh connection", async () => {
    const temp = newTempDb();
    const database = new SqliteDatabase(temp.path);
    const producerStates = new SqliteProducerStateRepository(database);
    const consumerStates = new SqliteConsumerStateRepository(database);

    expect(await producerStates.get("p-1")).toBe(true);
    await producerStates.setEnabled("p-1", false);
    expect(await producerStates.get("p-1")).toBe(false);
    await producerStates.setEnabled("p-1", true);
    expect(await producerStates.get("p-1")).toBe(true);

    expect(await consumerStates.get("c-1")).toBe(true);
    await consumerStates.setEnabled("c-1", false);
    expect(await consumerStates.get("c-1")).toBe(false);

    await database.close();

    const reopened = new SqliteDatabase(temp.path);
    const producerStates2 = new SqliteProducerStateRepository(reopened);
    const consumerStates2 = new SqliteConsumerStateRepository(reopened);

    expect(await producerStates2.get("p-1")).toBe(true);
    expect(await consumerStates2.get("c-1")).toBe(false);

    await reopened.close();
  });
});

describe("events.muted migration", () => {
  it("adds the muted column to a pre-existing database and backfills as audible", async () => {
    const temp = newTempDb();

    const legacy = new Database(temp.path);
    legacy.exec(`
      CREATE TABLE events (
        version TEXT NOT NULL,
        id TEXT PRIMARY KEY,
        producer_id TEXT NOT NULL,
        datetime TEXT NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE TABLE runs (
        version TEXT NOT NULL,
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL,
        state TEXT NOT NULL,
        FOREIGN KEY (event_id) REFERENCES events(id)
      );
    `);
    legacy.prepare(
      "INSERT INTO events (version, id, producer_id, datetime, type, payload) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("v1", "evt-old", "p-1", "2026-07-04T00:00:00Z", "foo", "{}");
    legacy.close();

    const database = new SqliteDatabase(temp.path);
    const eventStore = new SqliteEventStore(database);

    const columns = database.prepare("PRAGMA table_info(events)").all() as { name: string }[];
    expect(columns.some((column) => column.name === "muted")).toBe(true);

    const legacyEvent = await eventStore.getById("evt-old");
    expect(legacyEvent.muted).toBe(false);

    const mutedEvent = new Event<unknown>("evt-muted", "p-1", "pevt-muted", new Date("2026-07-04T00:00:00Z"), "foo", { x: 1 });
    mutedEvent.markMuted();
    await eventStore.save(mutedEvent);
    const restored = await eventStore.getById("evt-muted");
    expect(restored.muted).toBe(true);

    await database.close();
  });
});

describe("sqlite context store", () => {
  it("round-trips a context through save and getByName, supports overwrite, and lists ordered by name", async () => {
    const temp = newTempDb();
    const database = new SqliteDatabase(temp.path);
    const store = new SqliteContextStore(database);

    await store.save(new Context("bravo", { n: 2 }, {}));
    await store.save(new Context("alpha", { n: 1 }, {}));

    const restored = await store.getByName("alpha");
    expect(restored.payload).toEqual({ n: 1 });

    await store.save(new Context("alpha", { n: 11 }, {}));
    const overwritten = await store.getByName("alpha");
    expect(overwritten.payload).toEqual({ n: 11 });

    const page = await store.list({ limit: 50, offset: 0 });
    expect(page.total).toBe(2);
    expect(page.items.map((item) => item.name)).toEqual(["alpha", "bravo"]);

    const firstPage = await store.list({ limit: 1, offset: 0 });
    expect(firstPage.items.map((item) => item.name)).toEqual(["alpha"]);
    expect(firstPage.total).toBe(2);

    await store.delete("alpha");
    const afterDelete = await store.list({ limit: 50, offset: 0 });
    expect(afterDelete.total).toBe(1);

    await database.close();
  });

  it("throws ContextNotFoundError when a name is absent and reports existence correctly", async () => {
    const temp = newTempDb();
    const database = new SqliteDatabase(temp.path);
    const store = new SqliteContextStore(database);

    await expect(store.getByName("missing")).rejects.toBeInstanceOf(ContextNotFoundError);
    expect(await store.exists("missing")).toBe(false);
    await store.save(new Context("present", { x: 1 }, {}));
    expect(await store.exists("present")).toBe(true);

    await database.close();
  });

  it("persists on disk so a fresh connection reads the last-written state", async () => {
    const temp = newTempDb();

    const firstDb = new SqliteDatabase(temp.path);
    const firstStore = new SqliteContextStore(firstDb);
    await firstStore.save(new Context("greeting", { hello: "world" }, {}));
    await firstDb.close();

    const secondDb = new SqliteDatabase(temp.path);
    const secondStore = new SqliteContextStore(secondDb);
    const restored = await secondStore.getByName("greeting");
    expect(restored.payload).toEqual({ hello: "world" });

    await secondDb.close();
  });

  it("writes the v1 version tag to every row", async () => {
    const temp = newTempDb();
    const database = new SqliteDatabase(temp.path);
    const store = new SqliteContextStore(database);

    await store.save(new Context("greeting", { hello: "world" }, {}));

    const row = database.prepare(
      "SELECT version FROM contexts WHERE name = ?",
    ).get("greeting") as { version: string };

    expect(row.version).toBe(ContextV1.version);

    await database.close();
  });

  it("exposes the context store through the persistence bundle", async () => {
    const temp = newTempDb();
    const factory = new SqlitePersistenceFactory(temp.path);
    const bundle = factory.create();

    expect(bundle.contextStore).toBeDefined();
    await bundle.contextStore.save(new Context("greeting", { hello: "world" }, {}));
    const restored = await bundle.contextStore.getByName("greeting");
    expect(restored.payload).toEqual({ hello: "world" });

    await bundle.database.close();
  });

  it("round-trips a context with secrets through save and getByName", async () => {
    const temp = newTempDb();
    const database = new SqliteDatabase(temp.path);
    const store = new SqliteContextStore(database);

    await store.save(new Context("greeting", { hello: "world" }, { TOKEN: "abc", OTHER: "def" }));

    const restored = await store.getByName("greeting");
    expect(restored.payload).toEqual({ hello: "world" });
    expect(restored.secrets).toEqual({ TOKEN: "abc", OTHER: "def" });

    await database.close();
  });

  it("overwrites a single secret value via upsert while leaving the others intact", async () => {
    const temp = newTempDb();
    const database = new SqliteDatabase(temp.path);
    const store = new SqliteContextStore(database);

    await store.save(new Context("greeting", { hello: "world" }, { TOKEN: "abc", OTHER: "def" }));
    const existing = await store.getByName("greeting");
    const merged = { ...existing.secrets, TOKEN: "new" };
    await store.save(new Context("greeting", { hello: "world" }, merged));

    const restored = await store.getByName("greeting");
    expect(restored.secrets).toEqual({ TOKEN: "new", OTHER: "def" });

    await database.close();
  });

  it("returns contexts with their secrets through list", async () => {
    const temp = newTempDb();
    const database = new SqliteDatabase(temp.path);
    const store = new SqliteContextStore(database);

    await store.save(new Context("alpha", { n: 1 }, { ALPHA_TOKEN: "a" }));
    await store.save(new Context("bravo", { n: 2 }, { BRAVO_TOKEN: "b" }));

    const page = await store.list({ limit: 50, offset: 0 });
    expect(page.items[0].secrets).toEqual({ ALPHA_TOKEN: "a" });
    expect(page.items[1].secrets).toEqual({ BRAVO_TOKEN: "b" });

    await database.close();
  });
});

describe("contexts.secrets migration", () => {
  it("adds the secrets column to a pre-existing database and backfills as an empty map", async () => {
    const temp = newTempDb();

    const legacy = new Database(temp.path);
    legacy.exec(`
      CREATE TABLE contexts (
        version TEXT NOT NULL,
        name TEXT PRIMARY KEY,
        payload TEXT NOT NULL
      );
    `);
    legacy.prepare(
      "INSERT INTO contexts (version, name, payload) VALUES (?, ?, ?)",
    ).run("v1", "greeting", JSON.stringify({ hello: "world" }));
    legacy.close();

    const database = new SqliteDatabase(temp.path);
    const store = new SqliteContextStore(database);

    const columns = database.prepare("PRAGMA table_info(contexts)").all() as { name: string }[];
    expect(columns.some((column) => column.name === "secrets")).toBe(true);

    const restored = await store.getByName("greeting");
    expect(restored.payload).toEqual({ hello: "world" });
    expect(restored.secrets).toEqual({});

    await database.close();
  });
});

describe("sqlite credential store", () => {
  it("round-trips a credential through save and getByName and supports overwrite", async () => {
    const temp = newTempDb();
    const database = new SqliteDatabase(temp.path);
    const store = new SqliteCredentialStore(database);

    await store.save(new Credential("alice", "salt-1", "verifier-1"));

    const restored = await store.getByName("alice");
    expect(restored.salt).toBe("salt-1");
    expect(restored.verifier).toBe("verifier-1");

    await store.save(new Credential("alice", "salt-2", "verifier-2"));
    const overwritten = await store.getByName("alice");
    expect(overwritten.salt).toBe("salt-2");
    expect(overwritten.verifier).toBe("verifier-2");

    await database.close();
  });

  it("throws UserNotFoundError when a username is absent and reports existence correctly", async () => {
    const temp = newTempDb();
    const database = new SqliteDatabase(temp.path);
    const store = new SqliteCredentialStore(database);

    await expect(store.getByName("missing")).rejects.toBeInstanceOf(UserNotFoundError);
    expect(await store.exists("missing")).toBe(false);
    await store.save(new Credential("alice", "salt", "verifier"));
    expect(await store.exists("alice")).toBe(true);

    await database.close();
  });

  it("deletes a credential by username", async () => {
    const temp = newTempDb();
    const database = new SqliteDatabase(temp.path);
    const store = new SqliteCredentialStore(database);

    await store.save(new Credential("alice", "salt", "verifier"));
    await store.delete("alice");
    expect(await store.exists("alice")).toBe(false);

    await database.close();
  });

  it("writes the v1 version tag to every row", async () => {
    const temp = newTempDb();
    const database = new SqliteDatabase(temp.path);
    const store = new SqliteCredentialStore(database);

    await store.save(new Credential("alice", "salt", "verifier"));

    const row = database.prepare(
      "SELECT version FROM credentials WHERE username = ?",
    ).get("alice") as { version: string };

    expect(row.version).toBe(CredentialV1.version);

    await database.close();
  });

  it("persists on disk so a fresh connection reads the last-written state", async () => {
    const temp = newTempDb();

    const firstDb = new SqliteDatabase(temp.path);
    const firstStore = new SqliteCredentialStore(firstDb);
    await firstStore.save(new Credential("alice", "salt", "verifier"));
    await firstDb.close();

    const secondDb = new SqliteDatabase(temp.path);
    const secondStore = new SqliteCredentialStore(secondDb);
    const restored = await secondStore.getByName("alice");
    expect(restored.verifier).toBe("verifier");

    await secondDb.close();
  });

  it("exposes the credential store through the persistence bundle", async () => {
    const temp = newTempDb();
    const factory = new SqlitePersistenceFactory(temp.path);
    const bundle = factory.create();

    expect(bundle.credentialStore).toBeDefined();
    await bundle.credentialStore.save(new Credential("alice", "salt", "verifier"));
    const restored = await bundle.credentialStore.getByName("alice");
    expect(restored.verifier).toBe("verifier");

    await bundle.database.close();
  });
});

describe("sqlite pause state repository", () => {
  it("reads back as not paused on a fresh database", async () => {
    const temp = newTempDb();
    const database = new SqliteDatabase(temp.path);
    const repository = new SqlitePauseStateRepository(database);

    expect(await repository.isPaused()).toBe(false);

    await database.close();
  });

  it("round-trips a paused state through setPaused and isPaused", async () => {
    const temp = newTempDb();
    const database = new SqliteDatabase(temp.path);
    const repository = new SqlitePauseStateRepository(database);

    await repository.setPaused(true);
    expect(await repository.isPaused()).toBe(true);

    await repository.setPaused(false);
    expect(await repository.isPaused()).toBe(false);

    await database.close();
  });

  it("persists on disk so a fresh connection reads the last-written state", async () => {
    const temp = newTempDb();

    const firstDb = new SqliteDatabase(temp.path);
    const firstRepository = new SqlitePauseStateRepository(firstDb);
    await firstRepository.setPaused(true);
    await firstDb.close();

    const secondDb = new SqliteDatabase(temp.path);
    const secondRepository = new SqlitePauseStateRepository(secondDb);
    expect(await secondRepository.isPaused()).toBe(true);

    await secondDb.close();
  });

  it("exposes the pause state repository through the persistence bundle", () => {
    const temp = newTempDb();
    const factory = new SqlitePersistenceFactory(temp.path);
    const bundle = factory.create();

    expect(bundle.pauseStateRepository).toBeDefined();

    bundle.database.close();
  });
});

describe("sqlite session store", () => {
  it("round-trips a session through create, get, and touch", async () => {
    const temp = newTempDb();
    const database = new SqliteDatabase(temp.path);
    const store = new SqliteSessionStore(database);

    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    const id = await store.create({
      username: "alice",
      sessionKey: "key-1",
      expiresAt,
    });

    const restored = await store.get(id);
    expect(restored.username).toBe("alice");
    expect(restored.sessionKey).toBe("key-1");
    expect(restored.expiresAt.toISOString()).toBe(expiresAt.toISOString());

    const extended = new Date(Date.now() + 2 * 60 * 60 * 1000);
    await store.touch(id, extended);
    const afterTouch = await store.get(id);
    expect(afterTouch.expiresAt.toISOString()).toBe(extended.toISOString());

    await database.close();
  });

  it("throws SessionExpiredError for an unknown session id", async () => {
    const temp = newTempDb();
    const database = new SqliteDatabase(temp.path);
    const store = new SqliteSessionStore(database);

    await expect(store.get("missing")).rejects.toBeInstanceOf(SessionExpiredError);

    await database.close();
  });

  it("purges expired sessions on read", async () => {
    const temp = newTempDb();
    const database = new SqliteDatabase(temp.path);
    const store = new SqliteSessionStore(database);

    const past = new Date(Date.now() - 60_000);
    const id = await store.create({
      username: "alice",
      sessionKey: "key-1",
      expiresAt: past,
    });

    await expect(store.get(id)).rejects.toBeInstanceOf(SessionExpiredError);

    await database.close();
  });

  it("writes the v1 version tag to every row", async () => {
    const temp = newTempDb();
    const database = new SqliteDatabase(temp.path);
    const store = new SqliteSessionStore(database);

    const id = await store.create({
      username: "alice",
      sessionKey: "key-1",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const row = database.prepare(
      "SELECT version FROM sessions WHERE id = ?",
    ).get(id) as { version: string };

    expect(row.version).toBe(SessionV1.version);

    await database.close();
  });

  it("persists on disk so a fresh connection reads the last-written session", async () => {
    const temp = newTempDb();

    const firstDb = new SqliteDatabase(temp.path);
    const firstStore = new SqliteSessionStore(firstDb);
    const id = await firstStore.create({
      username: "alice",
      sessionKey: "key-1",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    await firstDb.close();

    const secondDb = new SqliteDatabase(temp.path);
    const secondStore = new SqliteSessionStore(secondDb);
    const restored = await secondStore.get(id);
    expect(restored.username).toBe("alice");
    expect(restored.sessionKey).toBe("key-1");

    await secondDb.close();
  });

  it("exposes the session store through the persistence bundle", () => {
    const temp = newTempDb();
    const factory = new SqlitePersistenceFactory(temp.path);
    const bundle = factory.create();

    expect(bundle.sessionStore).toBeDefined();
    expect(bundle.sessionStore).toBeInstanceOf(SqliteSessionStore);

    bundle.database.close();
  });
});

describe("sqlite run update repository", () => {
  it("round-trips a run update through save and listByRun preserving every field", async () => {
    const temp = newTempDb();
    const database = new SqliteDatabase(temp.path);
    const runUpdateRepository = new SqliteRunUpdateRepository(database);

    const createdAt = new Date("2026-07-28T09:00:00Z");
    const update = new RunUpdate("update-1", "run-1", "c-1", "Halfway done.", createdAt);
    await runUpdateRepository.save(update);

    const list = await runUpdateRepository.listByRun("run-1");
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("update-1");
    expect(list[0].runId).toBe("run-1");
    expect(list[0].consumerId).toBe("c-1");
    expect(list[0].message).toBe("Halfway done.");
    expect(list[0].createdAt).toEqual(createdAt);

    await database.close();
  });

  it("listByRun returns updates ordered by ascending creation time and filters by run", async () => {
    const temp = newTempDb();
    const database = new SqliteDatabase(temp.path);
    const runUpdateRepository = new SqliteRunUpdateRepository(database);

    await runUpdateRepository.save(
      new RunUpdate("update-2", "run-1", "c-1", "second", new Date("2026-07-28T10:00:00Z")),
    );
    await runUpdateRepository.save(
      new RunUpdate("update-1", "run-1", "c-1", "first", new Date("2026-07-28T09:00:00Z")),
    );
    await runUpdateRepository.save(
      new RunUpdate("update-other", "run-2", "c-2", "other run", new Date("2026-07-28T09:30:00Z")),
    );

    const list = await runUpdateRepository.listByRun("run-1");
    expect(list.map((u) => u.id)).toEqual(["update-1", "update-2"]);

    const empty = await runUpdateRepository.listByRun("run-empty");
    expect(empty).toEqual([]);

    await database.close();
  });

  it("writes the v1 version tag for each run_updates row", async () => {
    const temp = newTempDb();
    const database = new SqliteDatabase(temp.path);
    const runUpdateRepository = new SqliteRunUpdateRepository(database);

    await runUpdateRepository.save(
      new RunUpdate("update-1", "run-1", "c-1", "hi", new Date("2026-07-28T09:00:00Z")),
    );
    const row = database
      .prepare("SELECT version FROM run_updates WHERE id = ?")
      .get("update-1") as { version: string };
    expect(row.version).toBe(RunUpdateV1.version);

    await database.close();
  });

  it("creates the run_updates_run_id_idx index", async () => {
    const temp = newTempDb();
    const database = new SqliteDatabase(temp.path);

    const rows = database
      .prepare("PRAGMA index_list('run_updates')")
      .all() as { name: string }[];
    expect(rows.some((row) => row.name === "run_updates_run_id_idx")).toBe(true);

    database.close();
  });

  it("exposes the run update repository through the persistence bundle", () => {
    const temp = newTempDb();
    const factory = new SqlitePersistenceFactory(temp.path);
    const bundle = factory.create();

    expect(bundle.runUpdateRepository).toBeDefined();
    expect(bundle.runUpdateRepository).toBeInstanceOf(SqliteRunUpdateRepository);

    bundle.database.close();
  });
});

describe("sqlite pull request lifecycle store", () => {
  function state(overrides: Partial<{
    headSha: string;
    openedEmitted: boolean;
    mergeConflictsEmittedForSha: boolean;
    testsTerminalEmittedForSha: boolean;
    consecutiveEmptyScansForSha: number;
    mergedEmitted: boolean;
    terminal: boolean;
  }> = {}): PrLifecycleState {
    return {
      headSha: "sha-1",
      openedEmitted: true,
      mergeConflictsEmittedForSha: false,
      testsTerminalEmittedForSha: true,
      consecutiveEmptyScansForSha: 0,
      mergedEmitted: false,
      terminal: false,
      ...overrides,
    };
  }

  it("round-trips a lifecycle state through save and get preserving every field", async () => {
    const temp = newTempDb();
    const database = new SqliteDatabase(temp.path);
    const store = new SqlitePullRequestLifecycleStore(database);

    await store.save("example-corp/app#976", state({ headSha: "abc123", consecutiveEmptyScansForSha: 4 }));

    const restored = await store.get("example-corp/app#976");
    expect(restored).toEqual(state({ headSha: "abc123", consecutiveEmptyScansForSha: 4 }));

    await database.close();
  });

  it("returns null for an unknown key on a fresh database", async () => {
    const temp = newTempDb();
    const database = new SqliteDatabase(temp.path);
    const store = new SqlitePullRequestLifecycleStore(database);

    expect(await store.get("example-corp/app#999")).toBeNull();

    await database.close();
  });

  it("overwrites the state on a subsequent save for the same key", async () => {
    const temp = newTempDb();
    const database = new SqliteDatabase(temp.path);
    const store = new SqlitePullRequestLifecycleStore(database);

    await store.save("example-corp/app#976", state({ headSha: "sha-1", testsTerminalEmittedForSha: false }));
    await store.save("example-corp/app#976", state({ headSha: "sha-2", testsTerminalEmittedForSha: true }));

    const restored = await store.get("example-corp/app#976");
    expect(restored?.headSha).toBe("sha-2");
    expect(restored?.testsTerminalEmittedForSha).toBe(true);

    await database.close();
  });

  it("lists every stored entry with its key and state", async () => {
    const temp = newTempDb();
    const database = new SqliteDatabase(temp.path);
    const store = new SqlitePullRequestLifecycleStore(database);

    await store.save("example-corp/app#976", state({ headSha: "sha-976" }));
    await store.save("example-corp/concord#1", state({ headSha: "sha-1", terminal: true }));

    const entries = await store.list();
    expect(entries).toHaveLength(2);
    const byKey = new Map(entries.map((entry) => [entry.key, entry.state]));
    expect(byKey.get("example-corp/app#976")?.headSha).toBe("sha-976");
    expect(byKey.get("example-corp/concord#1")?.terminal).toBe(true);

    await database.close();
  });

  // This is the test that pins the bug: a non-durable (in-memory) store loses
  // every PR's state on restart, which makes the producer re-emit pr.opened for
  // all open PRs. A SQLite store must survive a connection reopen.
  it("persists on disk so a fresh connection reads the last-written state", async () => {
    const temp = newTempDb();

    const firstDb = new SqliteDatabase(temp.path);
    const firstStore = new SqlitePullRequestLifecycleStore(firstDb);
    await firstStore.save("example-corp/app#976", state({ headSha: "persisted-sha", openedEmitted: true }));
    await firstDb.close();

    const secondDb = new SqliteDatabase(temp.path);
    const secondStore = new SqlitePullRequestLifecycleStore(secondDb);
    const restored = await secondStore.get("example-corp/app#976");
    expect(restored?.headSha).toBe("persisted-sha");
    expect(restored?.openedEmitted).toBe(true);

    await secondDb.close();
  });

  it("exposes the lifecycle store through the persistence bundle", async () => {
    const temp = newTempDb();
    const factory = new SqlitePersistenceFactory(temp.path);
    const bundle = factory.create();

    expect(bundle.pullRequestLifecycleStore).toBeDefined();
    expect(bundle.pullRequestLifecycleStore).toBeInstanceOf(SqlitePullRequestLifecycleStore);
    await bundle.pullRequestLifecycleStore.save("example-corp/app#976", state());
    const restored = await bundle.pullRequestLifecycleStore.get("example-corp/app#976");
    expect(restored?.headSha).toBe("sha-1");

    await bundle.database.close();
  });
});
