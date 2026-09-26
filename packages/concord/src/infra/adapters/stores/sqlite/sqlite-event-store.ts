import type { Statement } from "better-sqlite3";
import type { EventStore } from "../../../../domain/ports/out/event-store";
import type { Event } from "../../../../domain/entities/event";
import type { Result } from "../../../../domain/result";
import { success, failure } from "../../../../domain/result";
import type { ConcordError } from "../../../../domain/exceptions/errors";
import {
  EventNotFoundError,
  PersistenceError,
  UnexpectedStateError,
} from "../../../../domain/exceptions/errors";
import type { ListQuery, ListResult } from "../../../../domain/list";
import type { SqliteDatabase } from "./sqlite-database";
import { EventV1 } from "./dto/event-v1";

interface EventRow {
  version: string;
  id: string;
  producer_id: string;
  producer_event_id: string;
  datetime: string;
  type: string;
  payload: string;
  muted: number;
}

interface CountRow {
  total: number;
}

interface ExistsRow {
  hit: number;
}

export class SqliteEventStore implements EventStore {
  private readonly insert: Statement;
  private readonly selectById: Statement;
  private readonly selectList: Statement;
  private readonly selectByProducerKey: Statement;
  private readonly countAll: Statement;

  public constructor(database: SqliteDatabase) {
    this.insert = database.prepare(
      "INSERT OR REPLACE INTO events (version, id, producer_id, producer_event_id, datetime, type, payload, muted) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    this.selectById = database.prepare(
      "SELECT version, id, producer_id, producer_event_id, datetime, type, payload, muted FROM events WHERE id = ?",
    );
    this.selectList = database.prepare(
      "SELECT version, id, producer_id, producer_event_id, datetime, type, payload, muted FROM events ORDER BY datetime DESC LIMIT ? OFFSET ?",
    );
    this.selectByProducerKey = database.prepare(
      "SELECT 1 AS hit FROM events WHERE producer_id = ? AND producer_event_id = ? LIMIT 1",
    );
    this.countAll = database.prepare("SELECT COUNT(*) AS total FROM events");
  }

  public async save(event: Event<unknown>): Promise<Result<void, ConcordError>> {
    try {
      const dto = EventV1.fromDomain(event);
      this.insert.run(
        EventV1.version,
        dto.id,
        dto.producerId,
        dto.producerEventId,
        dto.datetime,
        dto.type,
        dto.payload,
        dto.muted ? 1 : 0,
      );
      return success(undefined);
    } catch (cause) {
      return failure<void, ConcordError>(new PersistenceError(cause));
    }
  }

  public async existsByProducerKey(producerId: string, producerEventId: string): Promise<boolean> {
    const row = this.selectByProducerKey.get(producerId, producerEventId) as ExistsRow | undefined;
    return row !== undefined;
  }

  public async getById(id: string): Promise<Event<unknown>> {
    const row = this.selectById.get(id) as EventRow | undefined;
    if (row === undefined) {
      throw new EventNotFoundError(id);
    }
    return this.rowToEvent(row);
  }

  public async list(query: ListQuery): Promise<ListResult<Event<unknown>>> {
    const rows = this.selectList.all(query.limit, query.offset) as EventRow[];
    const countRow = this.countAll.get() as CountRow;
    const items = rows.map((row) => this.rowToEvent(row));
    return { items, total: countRow.total, limit: query.limit, offset: query.offset };
  }

  private rowToEvent(row: EventRow): Event<unknown> {
    if (row.version === EventV1.version) {
      const dto = new EventV1(
        row.id,
        row.producer_id,
        row.producer_event_id,
        row.datetime,
        row.type,
        row.payload,
        row.muted === 1,
      );
      return dto.toDomain();
    } else {
      throw new UnexpectedStateError(`Unknown event version: ${row.version}`);
    }
  }
}
