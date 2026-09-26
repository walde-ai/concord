import Database from "better-sqlite3";
import type { Database as BetterSqliteDatabase, Statement } from "better-sqlite3";
import type { Closeable } from "../../../main/closeable";

const SCHEMA_DDL = `
  CREATE TABLE IF NOT EXISTS events (
    version TEXT NOT NULL,
    id TEXT PRIMARY KEY,
    producer_id TEXT NOT NULL,
    producer_event_id TEXT NOT NULL DEFAULT '',
    datetime TEXT NOT NULL,
    type TEXT NOT NULL,
    payload TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS runs (
    version TEXT NOT NULL,
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL,
    consumer_id TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL,
    failure TEXT,
    FOREIGN KEY (event_id) REFERENCES events(id)
  );

  CREATE TABLE IF NOT EXISTS producer_states (
    version TEXT NOT NULL,
    id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS consumer_states (
    version TEXT NOT NULL,
    id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS contexts (
    version TEXT NOT NULL,
    name TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    secrets TEXT NOT NULL DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS credentials (
    version TEXT NOT NULL,
    username TEXT PRIMARY KEY,
    salt TEXT NOT NULL,
    verifier TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS pause_state (
    version TEXT NOT NULL,
    id INTEGER PRIMARY KEY CHECK (id = 1),
    paused INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS consumer_configs (
    version TEXT NOT NULL,
    consumer_id TEXT PRIMARY KEY,
    values_json TEXT NOT NULL DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS peak_hours (
    version TEXT NOT NULL,
    id INTEGER PRIMARY KEY CHECK (id = 1),
    start TEXT NOT NULL,
    end TEXT NOT NULL,
    timezone TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS run_forms (
    version TEXT NOT NULL,
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    consumer_id TEXT NOT NULL DEFAULT '',
    round INTEGER NOT NULL,
    status TEXT NOT NULL,
    definition TEXT NOT NULL,
    answers TEXT,
    created_at TEXT NOT NULL,
    answered_at TEXT
  );

  CREATE INDEX IF NOT EXISTS run_forms_run_id_idx ON run_forms (run_id);

  CREATE TABLE IF NOT EXISTS run_updates (
    version TEXT NOT NULL,
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    consumer_id TEXT NOT NULL DEFAULT '',
    message TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS run_updates_run_id_idx ON run_updates (run_id);

  CREATE TABLE IF NOT EXISTS logs (
    version TEXT NOT NULL,
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    level TEXT NOT NULL,
    source TEXT NOT NULL,
    message TEXT NOT NULL,
    fields_json TEXT,
    event_id TEXT,
    run_id TEXT,
    consumer_id TEXT
  );

  CREATE INDEX IF NOT EXISTS logs_timestamp_idx ON logs (timestamp);
  CREATE INDEX IF NOT EXISTS logs_level_idx ON logs (level);
  CREATE INDEX IF NOT EXISTS logs_source_idx ON logs (source);

  CREATE TABLE IF NOT EXISTS sessions (
    version TEXT NOT NULL,
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    session_key TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions (expires_at);

  CREATE TABLE IF NOT EXISTS pr_lifecycle_state (
    version TEXT NOT NULL,
    key TEXT PRIMARY KEY,
    state_json TEXT NOT NULL
  );
`;

interface TableColumn {
  readonly name: string;
}

export class SqliteDatabase implements Closeable {
  private readonly db: BetterSqliteDatabase;

  public constructor(filePath: string) {
    this.db = new Database(filePath);
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(SCHEMA_DDL);
    this.migrateEventsMuted();
    this.migrateEventsProducerEventId();
    this.migrateRunsConsumerId();
    this.migrateRunsFailure();
    this.migrateRunsTimestamps();
    this.migrateContextsSecrets();
    this.migrateConsumerStatesWaitForOffPeak();
    this.migrateConsumerConfigsSecrets();
    this.migrateLogsCorrelationFields();
  }

  public prepare(sql: string): Statement {
    return this.db.prepare(sql);
  }

  public exec(sql: string): void {
    this.db.exec(sql);
  }

  public async close(): Promise<void> {
    this.db.close();
  }

  private migrateEventsMuted(): void {
    const columns = this.db.prepare("PRAGMA table_info(events)").all() as TableColumn[];
    const hasMuted = columns.some((column) => column.name === "muted");
    if (!hasMuted) {
      this.db.exec("ALTER TABLE events ADD COLUMN muted INTEGER NOT NULL DEFAULT 0");
    }
  }

  private migrateEventsProducerEventId(): void {
    const columns = this.db.prepare("PRAGMA table_info(events)").all() as TableColumn[];
    const hasProducerEventId = columns.some((column) => column.name === "producer_event_id");
    if (!hasProducerEventId) {
      this.db.exec("ALTER TABLE events ADD COLUMN producer_event_id TEXT NOT NULL DEFAULT ''");
    }
    this.db.exec("UPDATE events SET producer_event_id = id WHERE producer_event_id = ''");
    this.db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_events_producer_key ON events (producer_id, producer_event_id)",
    );
  }

  private migrateRunsConsumerId(): void {
    const columns = this.db.prepare("PRAGMA table_info(runs)").all() as TableColumn[];
    const hasConsumerId = columns.some((column) => column.name === "consumer_id");
    if (!hasConsumerId) {
      this.db.exec("ALTER TABLE runs ADD COLUMN consumer_id TEXT NOT NULL DEFAULT ''");
    }
  }

  private migrateRunsFailure(): void {
    const columns = this.db.prepare("PRAGMA table_info(runs)").all() as TableColumn[];
    const hasFailure = columns.some((column) => column.name === "failure");
    if (!hasFailure) {
      this.db.exec("ALTER TABLE runs ADD COLUMN failure TEXT");
    }
  }

  private migrateRunsTimestamps(): void {
    const columns = this.db.prepare("PRAGMA table_info(runs)").all() as TableColumn[];
    const hasStartedAt = columns.some((column) => column.name === "started_at");
    if (!hasStartedAt) {
      this.db.exec("ALTER TABLE runs ADD COLUMN started_at TEXT");
    }
    const hasFinishedAt = columns.some((column) => column.name === "finished_at");
    if (!hasFinishedAt) {
      this.db.exec("ALTER TABLE runs ADD COLUMN finished_at TEXT");
    }
  }

  private migrateContextsSecrets(): void {
    const columns = this.db.prepare("PRAGMA table_info(contexts)").all() as TableColumn[];
    const hasSecrets = columns.some((column) => column.name === "secrets");
    if (!hasSecrets) {
      this.db.exec("ALTER TABLE contexts ADD COLUMN secrets TEXT NOT NULL DEFAULT '{}'");
    }
  }

  private migrateConsumerStatesWaitForOffPeak(): void {
    const columns = this.db.prepare("PRAGMA table_info(consumer_states)").all() as TableColumn[];
    const hasWaitForOffPeak = columns.some((column) => column.name === "wait_for_off_peak");
    if (!hasWaitForOffPeak) {
      this.db.exec("ALTER TABLE consumer_states ADD COLUMN wait_for_off_peak INTEGER NOT NULL DEFAULT 0");
    }
  }

  private migrateConsumerConfigsSecrets(): void {
    const columns = this.db.prepare("PRAGMA table_info(consumer_configs)").all() as TableColumn[];
    const hasSecrets = columns.some((column) => column.name === "secrets_json");
    if (!hasSecrets) {
      this.db.exec("ALTER TABLE consumer_configs ADD COLUMN secrets_json TEXT NOT NULL DEFAULT '{}'");
    }
  }

  /**
   * Adds the event/run/consumer correlation columns to the `logs` table for
   * databases created before log enrichment landed. The columns are nullable
   * shadow copies of the same values stored in `fields_json`, kept as real
   * columns purely so the log query can filter on indexed dimensions instead of
   * scanning and parsing every row's JSON.
   */
  private migrateLogsCorrelationFields(): void {
    const columns = this.db.prepare("PRAGMA table_info(logs)").all() as TableColumn[];
    const hasEventId = columns.some((column) => column.name === "event_id");
    if (!hasEventId) {
      this.db.exec("ALTER TABLE logs ADD COLUMN event_id TEXT");
    }
    const hasRunId = columns.some((column) => column.name === "run_id");
    if (!hasRunId) {
      this.db.exec("ALTER TABLE logs ADD COLUMN run_id TEXT");
    }
    const hasConsumerId = columns.some((column) => column.name === "consumer_id");
    if (!hasConsumerId) {
      this.db.exec("ALTER TABLE logs ADD COLUMN consumer_id TEXT");
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS logs_event_id_idx ON logs (event_id)");
    this.db.exec("CREATE INDEX IF NOT EXISTS logs_run_id_idx ON logs (run_id)");
    this.db.exec("CREATE INDEX IF NOT EXISTS logs_consumer_id_idx ON logs (consumer_id)");
  }
}
