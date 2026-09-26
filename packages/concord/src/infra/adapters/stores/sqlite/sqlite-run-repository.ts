import type { Statement } from "better-sqlite3";
import type { RunRepository } from "../../../../domain/ports/out/run-repository";
import type { Run } from "../../../../domain/entities/run";
import type { RunState } from "../../../../domain/entities/run";
import type { Event } from "../../../../domain/entities/event";
import type { Result } from "../../../../domain/result";
import { success, failure } from "../../../../domain/result";
import type { ConcordError } from "../../../../domain/exceptions/errors";
import {
  RunNotFoundError,
  PersistenceError,
  UnexpectedStateError,
} from "../../../../domain/exceptions/errors";
import type { ListQuery, ListResult } from "../../../../domain/list";
import type { SqliteDatabase } from "./sqlite-database";
import { EventV1 } from "./dto/event-v1";
import { RunV1, serializeRunFailure, deserializeRunFailure } from "./dto/run-v1";

interface RunJoinRow {
  run_version: string;
  run_id: string;
  run_event_id: string;
  run_consumer_id: string;
  run_state: string;
  run_failure: string | null;
  run_started_at: string | null;
  run_finished_at: string | null;
  event_version: string;
  event_id: string;
  event_producer_id: string;
  event_producer_event_id: string;
  event_datetime: string;
  event_type: string;
  event_payload: string;
  event_muted: number;
}

interface CountRow {
  total: number;
}

const JOIN_SELECT = `
  runs.version AS run_version,
  runs.id AS run_id,
  runs.event_id AS run_event_id,
  runs.consumer_id AS run_consumer_id,
  runs.state AS run_state,
  runs.failure AS run_failure,
  runs.started_at AS run_started_at,
  runs.finished_at AS run_finished_at,
  events.version AS event_version,
  events.id AS event_id,
  events.producer_id AS event_producer_id,
  events.producer_event_id AS event_producer_event_id,
  events.datetime AS event_datetime,
  events.type AS event_type,
  events.payload AS event_payload,
  events.muted AS event_muted
FROM runs
  JOIN events ON runs.event_id = events.id`;

export class SqliteRunRepository implements RunRepository {
  private readonly insert: Statement;
  private readonly selectById: Statement;
  private readonly selectList: Statement;
  private readonly selectListByEventId: Statement;
  private readonly selectListByState: Statement;
  private readonly selectListByConsumer: Statement;
  private readonly countAll: Statement;
  private readonly countByEventId: Statement;
  private readonly countByState: Statement;
  private readonly countByConsumer: Statement;

  public constructor(database: SqliteDatabase) {
    this.insert = database.prepare(
      "INSERT OR REPLACE INTO runs (version, id, event_id, consumer_id, state, failure, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    this.selectById = database.prepare(
      `SELECT ${JOIN_SELECT} WHERE runs.id = ?`,
    );
    this.selectList = database.prepare(
      `SELECT ${JOIN_SELECT} ORDER BY events.datetime DESC, runs.rowid DESC LIMIT ? OFFSET ?`,
    );
    this.selectListByEventId = database.prepare(
      `SELECT ${JOIN_SELECT} WHERE runs.event_id = ? ORDER BY events.datetime DESC, runs.rowid DESC LIMIT ? OFFSET ?`,
    );
    this.selectListByState = database.prepare(
      `SELECT ${JOIN_SELECT} WHERE runs.state = ? ORDER BY runs.rowid DESC LIMIT ? OFFSET ?`,
    );
    this.selectListByConsumer = database.prepare(
      `SELECT ${JOIN_SELECT} WHERE runs.consumer_id = ? ORDER BY events.datetime DESC, runs.rowid DESC LIMIT ? OFFSET ?`,
    );
    this.countAll = database.prepare("SELECT COUNT(*) AS total FROM runs");
    this.countByEventId = database.prepare(
      "SELECT COUNT(*) AS total FROM runs WHERE event_id = ?",
    );
    this.countByState = database.prepare("SELECT COUNT(*) AS total FROM runs WHERE state = ?");
    this.countByConsumer = database.prepare("SELECT COUNT(*) AS total FROM runs WHERE consumer_id = ?");
  }

  public async save(run: Run<unknown>): Promise<Result<void, ConcordError>> {
    try {
    const dto = RunV1.fromDomain(run);
    this.insert.run(
      RunV1.version,
      dto.id,
      dto.eventId,
      dto.consumerId,
      dto.state,
      serializeRunFailure(dto.failure),
      dto.startedAt,
      dto.finishedAt,
    );
      return success(undefined);
    } catch (cause) {
      return failure<void, ConcordError>(new PersistenceError(cause));
    }
  }

  public async getById(id: string): Promise<Run<unknown>> {
    const row = this.selectById.get(id) as RunJoinRow | undefined;
    if (row === undefined) {
      throw new RunNotFoundError(id);
    }
    const event = this.resolveEvent(row);
    return this.resolveRun(row, event);
  }

  public async list(query: ListQuery): Promise<ListResult<Run<unknown>>> {
    const rows = this.selectList.all(query.limit, query.offset) as RunJoinRow[];
    const countRow = this.countAll.get() as CountRow;
    const items = rows.map((row) => this.resolveRun(row, this.resolveEvent(row)));
    return { items, total: countRow.total, limit: query.limit, offset: query.offset };
  }

  public async listByEventId(eventId: string, query: ListQuery): Promise<ListResult<Run<unknown>>> {
    const rows = this.selectListByEventId.all(eventId, query.limit, query.offset) as RunJoinRow[];
    const countRow = this.countByEventId.get(eventId) as CountRow;
    const items = rows.map((row) => this.resolveRun(row, this.resolveEvent(row)));
    return { items, total: countRow.total, limit: query.limit, offset: query.offset };
  }

  public async listByState(state: RunState, query: ListQuery): Promise<ListResult<Run<unknown>>> {
    const rows = this.selectListByState.all(state, query.limit, query.offset) as RunJoinRow[];
    const countRow = this.countByState.get(state) as CountRow;
    const items = rows.map((row) => this.resolveRun(row, this.resolveEvent(row)));
    return { items, total: countRow.total, limit: query.limit, offset: query.offset };
  }

  public async listByConsumer(consumerId: string, query: ListQuery): Promise<ListResult<Run<unknown>>> {
    const rows = this.selectListByConsumer.all(consumerId, query.limit, query.offset) as RunJoinRow[];
    const countRow = this.countByConsumer.get(consumerId) as CountRow;
    const items = rows.map((row) => this.resolveRun(row, this.resolveEvent(row)));
    return { items, total: countRow.total, limit: query.limit, offset: query.offset };
  }

  private resolveEvent(row: RunJoinRow): Event<unknown> {
    if (row.event_version === EventV1.version) {
      const dto = new EventV1(
        row.event_id,
        row.event_producer_id,
        row.event_producer_event_id,
        row.event_datetime,
        row.event_type,
        row.event_payload,
        row.event_muted === 1,
      );
      return dto.toDomain();
    } else {
      throw new UnexpectedStateError(`Unknown event version: ${row.event_version}`);
    }
  }

  private resolveRun(row: RunJoinRow, event: Event<unknown>): Run<unknown> {
    if (row.run_version === RunV1.version) {
      const dto = new RunV1(
        row.run_id,
        row.run_event_id,
        row.run_consumer_id,
        row.run_state as RunState,
        deserializeRunFailure(row.run_failure),
        row.run_started_at,
        row.run_finished_at,
      );
      return dto.toDomain(event);
    } else {
      throw new UnexpectedStateError(`Unknown run version: ${row.run_version}`);
    }
  }
}
