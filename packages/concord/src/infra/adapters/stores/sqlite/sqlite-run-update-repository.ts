import type { Statement } from "better-sqlite3";
import type { RunUpdateRepository } from "../../../../domain/ports/out/run-update-repository";
import type { RunUpdate } from "../../../../domain/entities/run-update";
import { UnexpectedStateError } from "../../../../domain/exceptions/errors";
import type { SqliteDatabase } from "./sqlite-database";
import { RunUpdateV1 } from "./dto/run-update-v1";

interface RunUpdateRow {
  readonly version: string;
  readonly id: string;
  readonly run_id: string;
  readonly consumer_id: string;
  readonly message: string;
  readonly created_at: string;
}

const SELECT_COLUMNS = `
  version,
  id,
  run_id,
  consumer_id,
  message,
  created_at
FROM run_updates
`;

export class SqliteRunUpdateRepository implements RunUpdateRepository {
  private readonly upsert: Statement;
  private readonly selectByRun: Statement;

  public constructor(database: SqliteDatabase) {
    this.upsert = database.prepare(
      "INSERT OR REPLACE INTO run_updates (version, id, run_id, consumer_id, message, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    this.selectByRun = database.prepare(
      `SELECT ${SELECT_COLUMNS} WHERE run_id = ? ORDER BY created_at ASC`,
    );
  }

  public async save(update: RunUpdate): Promise<void> {
    const dto = RunUpdateV1.fromDomain(update);
    this.upsert.run(
      RunUpdateV1.version,
      dto.id,
      dto.runId,
      dto.consumerId,
      dto.message,
      dto.createdAt,
    );
  }

  public async listByRun(runId: string): Promise<RunUpdate[]> {
    const rows = this.selectByRun.all(runId) as RunUpdateRow[];
    return rows.map((row) => this.toDomain(row));
  }

  private toDomain(row: RunUpdateRow): RunUpdate {
    if (row.version !== RunUpdateV1.version) {
      throw new UnexpectedStateError(`Unknown run_updates version: ${row.version}`);
    }
    return new RunUpdateV1(
      row.id,
      row.run_id,
      row.consumer_id,
      row.message,
      row.created_at,
    ).toDomain();
  }
}
