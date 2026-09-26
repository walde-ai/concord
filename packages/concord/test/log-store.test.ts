import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { LogEntry } from "../src/domain/ports/out/logger";
import { InMemoryLogStore } from "../src/infra/adapters/stores/in-memory-log-store";
import { SqliteDatabase } from "../src/infra/adapters/stores/sqlite/sqlite-database";
import { SqliteLogStore } from "../src/infra/adapters/stores/sqlite/sqlite-log-store";
import Database from "better-sqlite3";
import type { LogStore } from "../src/domain/ports/out/log-store";

interface TempDb {
  readonly path: string;
  readonly dir: string;
}

function createTempDb(): TempDb {
  const dir = mkdtempSync(join(tmpdir(), "concord-log-store-"));
  const path = join(dir, "test.db");
  return { path, dir };
}

function cleanupTempDb(temp: TempDb): void {
  rmSync(temp.dir, { recursive: true, force: true });
}

const tempDbs: TempDb[] = [];
afterEach(() => {
  while (tempDbs.length > 0) {
    const temp = tempDbs.pop()!;
    cleanupTempDb(temp);
  }
});

function entry(
  message: string,
  fields: Record<string, unknown>,
  timestamp = "2026-07-11T10:00:00.000Z",
): LogEntry {
  return { timestamp, level: "info", source: "unit", message, fields };
}

function inMemoryStore(): LogStore {
  return new InMemoryLogStore();
}

function sqliteStore(): LogStore {
  const temp = createTempDb();
  tempDbs.push(temp);
  const database = new SqliteDatabase(temp.path);
  return new SqliteLogStore(database, 30);
}

function sqliteStoreOnLegacySchema(): { store: LogStore; raw: Database.Database; path: string } {
  const temp = createTempDb();
  tempDbs.push(temp);
  // Build the logs table WITHOUT the correlation columns, the way it looked
  // before enrichment, then open via SqliteDatabase to run the migration.
  const raw = new Database(temp.path);
  raw.exec(`
    CREATE TABLE logs (
      version TEXT NOT NULL,
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      level TEXT NOT NULL,
      source TEXT NOT NULL,
      message TEXT NOT NULL,
      fields_json TEXT
    );
    CREATE INDEX logs_timestamp_idx ON logs (timestamp);
  `);
  const database = new SqliteDatabase(temp.path);
  const store = new SqliteLogStore(database, 30);
  return { store, raw, path: temp.path };
}

describe.each([
  ["InMemoryLogStore", inMemoryStore],
  ["SqliteLogStore", sqliteStore],
])("%s correlation filtering", (_name, makeStore) => {
  it("filters by eventId and returns every run of that event", async () => {
    const store = makeStore();
    await store.append(entry("a", { eventId: "evt-1", runId: "run-1", consumerId: "c-1" }));
    await store.append(entry("b", { eventId: "evt-1", runId: "run-2", consumerId: "c-1" }));
    await store.append(entry("c", { eventId: "evt-2", runId: "run-3", consumerId: "c-2" }));

    const result = await store.query({ limit: 50, offset: 0, eventId: "evt-1" });
    expect(result.total).toBe(2);
    expect(result.items.map((e) => e.message).sort()).toEqual(["a", "b"]);
  });

  it("filters by runId down to a single run's logs", async () => {
    const store = makeStore();
    await store.append(entry("a", { eventId: "evt-1", runId: "run-1", consumerId: "c-1" }));
    await store.append(entry("b", { eventId: "evt-1", runId: "run-1", consumerId: "c-1" }, "2026-07-11T10:00:01.000Z"));
    await store.append(entry("c", { eventId: "evt-1", runId: "run-2", consumerId: "c-1" }));

    const result = await store.query({ limit: 50, offset: 0, runId: "run-1" });
    expect(result.total).toBe(2);
    expect(result.items.map((e) => e.message).sort()).toEqual(["a", "b"]);
  });

  it("combines eventId and consumerId filters", async () => {
    const store = makeStore();
    await store.append(entry("a", { eventId: "evt-1", runId: "run-1", consumerId: "c-1" }));
    await store.append(entry("b", { eventId: "evt-1", runId: "run-2", consumerId: "c-2" }));

    const result = await store.query({ limit: 50, offset: 0, eventId: "evt-1", consumerId: "c-2" });
    expect(result.total).toBe(1);
    expect(result.items[0].message).toBe("b");
  });

  it("returns enrichment fields on the entries it matches", async () => {
    const store = makeStore();
    await store.append(entry("a", { eventId: "evt-1", runId: "run-1", consumerId: "c-1" }));

    const result = await store.query({ limit: 50, offset: 0, runId: "run-1" });
    expect(result.items[0].fields).toMatchObject({
      eventId: "evt-1",
      runId: "run-1",
      consumerId: "c-1",
    });
  });
});

describe("SqliteLogStore correlation migration", () => {
  it("adds event_id/run_id/consumer_id columns to a pre-enrichment database and indexes them", async () => {
    const { store, raw } = sqliteStoreOnLegacySchema();

    // A row written through the migrated store must populate the new columns.
    await store.append(entry("migrated", { eventId: "evt-9", runId: "run-9", consumerId: "c-9" }));

    const matched = await store.query({ limit: 50, offset: 0, eventId: "evt-9" });
    expect(matched.total).toBe(1);
    expect(matched.items[0].message).toBe("migrated");

    const columns = raw.prepare("PRAGMA table_info(logs)").all() as Array<{ name: string }>;
    const names = columns.map((column) => column.name);
    expect(names).toContain("event_id");
    expect(names).toContain("run_id");
    expect(names).toContain("consumer_id");

    const indexes = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'logs'").all() as Array<{ name: string }>;
    const indexNames = indexes.map((index) => index.name);
    expect(indexNames).toContain("logs_event_id_idx");
    expect(indexNames).toContain("logs_run_id_idx");
    expect(indexNames).toContain("logs_consumer_id_idx");
  });
});
