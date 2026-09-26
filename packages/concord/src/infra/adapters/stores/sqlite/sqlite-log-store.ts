import type { Statement } from "better-sqlite3";
import type { LogEntry } from "../../../../domain/ports/out/logger";
import {
  LOG_FIELD_CONSUMER_ID,
  LOG_FIELD_EVENT_ID,
  LOG_FIELD_RUN_ID,
} from "../../../../domain/ports/out/log-context";
import type { LogStore, LogStoreQuery, LogStoreResult } from "../../../../domain/ports/out/log-store";
import type { SqliteDatabase } from "./sqlite-database";
import { LogV1 } from "./dto/log-v1";

interface LogRow {
  version: string;
  timestamp: string;
  level: string;
  source: string;
  message: string;
  fields_json: string | null;
}

interface CountRow {
  total: number;
}

interface SourceRow {
  source: string;
}

const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

let lastPruneTime = 0;

export class SqliteLogStore implements LogStore {
  private readonly database: SqliteDatabase;
  private readonly insert: Statement;
  private readonly selectSources: Statement;
  private readonly deleteOldLogs: Statement;
  private readonly retentionDays: number;

  public constructor(database: SqliteDatabase, retentionDays: number = 30) {
    this.database = database;
    this.insert = database.prepare(
      "INSERT INTO logs (version, timestamp, level, source, message, fields_json, event_id, run_id, consumer_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    this.selectSources = database.prepare(
      "SELECT DISTINCT source FROM logs ORDER BY source ASC",
    );
    this.deleteOldLogs = database.prepare(
      "DELETE FROM logs WHERE timestamp < ?",
    );
    this.retentionDays = retentionDays;
  }

  public async append(entry: LogEntry): Promise<void> {
    this.maybePrune();
    const dto = LogV1.fromDomain(entry);
    this.insert.run(
      LogV1.version,
      dto.timestamp,
      dto.level,
      dto.source,
      dto.message,
      dto.fieldsJson,
      readStringField(entry, LOG_FIELD_EVENT_ID),
      readStringField(entry, LOG_FIELD_RUN_ID),
      readStringField(entry, LOG_FIELD_CONSUMER_ID),
    );
  }

  public async query(query: LogStoreQuery): Promise<LogStoreResult> {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (query.level !== undefined) {
      conditions.push("level = ?");
      params.push(query.level);
    }
    if (query.source !== undefined) {
      conditions.push("source = ?");
      params.push(query.source);
    }
    if (query.text !== undefined) {
      conditions.push("message LIKE ?");
      params.push(`%${query.text}%`);
    }
    if (query.startTime !== undefined) {
      conditions.push("timestamp >= ?");
      params.push(query.startTime);
    }
    if (query.endTime !== undefined) {
      conditions.push("timestamp <= ?");
      params.push(query.endTime);
    }
    if (query.eventId !== undefined) {
      conditions.push("event_id = ?");
      params.push(query.eventId);
    }
    if (query.runId !== undefined) {
      conditions.push("run_id = ?");
      params.push(query.runId);
    }
    if (query.consumerId !== undefined) {
      conditions.push("consumer_id = ?");
      params.push(query.consumerId);
    }

    const whereClause = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";

    const countSql = `SELECT COUNT(*) AS total FROM logs${whereClause}`;
    const listSql = `SELECT version, timestamp, level, source, message, fields_json FROM logs${whereClause} ORDER BY timestamp DESC LIMIT ? OFFSET ?`;

    const countParams = [...params];
    const listParams = [...params, query.limit, query.offset];

    const countRow = this.database.prepare(countSql).get(...countParams) as CountRow;
    const rows = this.database.prepare(listSql).all(...listParams) as LogRow[];

    const items = rows.map((row) => this.rowToEntry(row));

    return {
      items,
      total: countRow.total,
      limit: query.limit,
      offset: query.offset,
    };
  }

  public async distinctSources(): Promise<string[]> {
    const rows = this.selectSources.all() as SourceRow[];
    return rows.map((row) => row.source);
  }

  private maybePrune(): void {
    const now = Date.now();
    if (now - lastPruneTime < PRUNE_INTERVAL_MS) {
      return;
    }
    lastPruneTime = now;
    const cutoff = new Date(now - this.retentionDays * 24 * 60 * 60 * 1000).toISOString();
    this.deleteOldLogs.run(cutoff);
  }

  private rowToEntry(row: LogRow): LogEntry {
    if (row.version === LogV1.version) {
      const dto = new LogV1(
        row.timestamp,
        row.level,
        row.source,
        row.message,
        row.fields_json,
      );
      return dto.toDomain();
    }
    return {
      timestamp: row.timestamp,
      level: row.level as LogEntry["level"],
      source: row.source,
      message: row.message,
      fields: row.fields_json !== null ? JSON.parse(row.fields_json) as Record<string, unknown> : undefined,
    };
  }
}

function readStringField(entry: LogEntry, key: string): string | null {
  if (entry.fields === undefined) {
    return null;
  }
  const value = entry.fields[key];
  return typeof value === "string" ? value : null;
}
