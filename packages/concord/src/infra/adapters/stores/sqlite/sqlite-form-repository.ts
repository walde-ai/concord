import type { Statement } from "better-sqlite3";
import type { FormRepository } from "../../../../domain/ports/out/form-repository";
import type { RunForm } from "../../../../domain/entities/run-form";
import {
  FormNotFoundError,
  UnexpectedStateError,
} from "../../../../domain/exceptions/errors";
import type { SqliteDatabase } from "./sqlite-database";
import { FormV1 } from "./dto/form-v1";

interface FormRow {
  readonly version: string;
  readonly id: string;
  readonly run_id: string;
  readonly consumer_id: string;
  readonly round: number;
  readonly status: string;
  readonly definition: string;
  readonly answers: string | null;
  readonly created_at: string;
  readonly answered_at: string | null;
}

interface CountRow {
  readonly total: number;
}

const SELECT_COLUMNS = `
  version,
  id,
  run_id,
  consumer_id,
  round,
  status,
  definition,
  answers,
  created_at,
  answered_at
FROM run_forms
`;

export class SqliteFormRepository implements FormRepository {
  private readonly upsert: Statement;
  private readonly selectById: Statement;
  private readonly selectByRun: Statement;
  private readonly countByRunStatement: Statement;
  private readonly selectPendingByRun: Statement;

  public constructor(database: SqliteDatabase) {
    this.upsert = database.prepare(
      "INSERT OR REPLACE INTO run_forms (version, id, run_id, consumer_id, round, status, definition, answers, created_at, answered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    this.selectById = database.prepare(`SELECT ${SELECT_COLUMNS} WHERE id = ?`);
    this.selectByRun = database.prepare(`SELECT ${SELECT_COLUMNS} WHERE run_id = ? ORDER BY round ASC`);
    this.countByRunStatement = database.prepare("SELECT COUNT(*) AS total FROM run_forms WHERE run_id = ?");
    this.selectPendingByRun = database.prepare(
      `SELECT ${SELECT_COLUMNS} WHERE run_id = ? AND status = 'PENDING' ORDER BY round ASC LIMIT 1`,
    );
  }

  public async save(form: RunForm): Promise<void> {
    const dto = FormV1.fromDomain(form);
    this.upsert.run(
      FormV1.version,
      dto.id,
      dto.runId,
      dto.consumerId,
      dto.round,
      dto.status,
      dto.definition,
      dto.answers,
      dto.createdAt,
      dto.answeredAt,
    );
  }

  public async getById(id: string): Promise<RunForm> {
    const row = this.selectById.get(id) as FormRow | undefined;
    if (row === undefined) {
      throw new FormNotFoundError(id);
    }
    return this.toDomain(row);
  }

  public async listByRun(runId: string): Promise<RunForm[]> {
    const rows = this.selectByRun.all(runId) as FormRow[];
    return rows.map((row) => this.toDomain(row));
  }

  public async countByRun(runId: string): Promise<number> {
    const row = this.countByRunStatement.get(runId) as CountRow;
    return row.total;
  }

  public async getPendingByRun(runId: string): Promise<RunForm | null> {
    const row = this.selectPendingByRun.get(runId) as FormRow | undefined;
    if (row === undefined) {
      return null;
    }
    return this.toDomain(row);
  }

  private toDomain(row: FormRow): RunForm {
    if (row.version !== FormV1.version) {
      throw new UnexpectedStateError(`Unknown run_forms version: ${row.version}`);
    }
    return new FormV1(
      row.id,
      row.run_id,
      row.consumer_id,
      row.round,
      row.status as RunForm["status"],
      row.definition,
      row.answers,
      row.created_at,
      row.answered_at,
    ).toDomain();
  }
}
