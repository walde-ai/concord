import type { Statement } from "better-sqlite3";
import type { ContextStore } from "../../../../domain/ports/out/context-store";
import type { Context } from "../../../../domain/entities/context";
import type { Result } from "../../../../domain/result";
import { success, failure } from "../../../../domain/result";
import type { ConcordError } from "../../../../domain/exceptions/errors";
import {
  ContextNotFoundError,
  PersistenceError,
  UnexpectedStateError,
} from "../../../../domain/exceptions/errors";
import type { ListQuery, ListResult } from "../../../../domain/list";
import type { SqliteDatabase } from "./sqlite-database";
import { ContextV1 } from "./dto/context-v1";

interface ContextRow {
  version: string;
  name: string;
  payload: string;
  secrets: string;
}

interface CountRow {
  total: number;
}

export class SqliteContextStore implements ContextStore {
  private readonly selectByName: Statement;
  private readonly existsStatement: Statement;
  private readonly upsert: Statement;
  private readonly deleteStatement: Statement;
  private readonly selectList: Statement;
  private readonly countAll: Statement;

  public constructor(database: SqliteDatabase) {
    this.selectByName = database.prepare(
      "SELECT version, name, payload, secrets FROM contexts WHERE name = ?",
    );
    this.existsStatement = database.prepare(
      "SELECT 1 FROM contexts WHERE name = ?",
    );
    this.upsert = database.prepare(
      "INSERT OR REPLACE INTO contexts (version, name, payload, secrets) VALUES (?, ?, ?, ?)",
    );
    this.deleteStatement = database.prepare(
      "DELETE FROM contexts WHERE name = ?",
    );
    this.selectList = database.prepare(
      "SELECT version, name, payload, secrets FROM contexts ORDER BY name ASC LIMIT ? OFFSET ?",
    );
    this.countAll = database.prepare("SELECT COUNT(*) AS total FROM contexts");
  }

  public async getByName(name: string): Promise<Context> {
    const row = this.selectByName.get(name) as ContextRow | undefined;
    if (row === undefined) {
      throw new ContextNotFoundError(name);
    }
    return this.rowToContext(row);
  }

  public async exists(name: string): Promise<boolean> {
    const row = this.existsStatement.get(name);
    return row !== undefined;
  }

  public async save(context: Context): Promise<Result<void, ConcordError>> {
    try {
      const dto = ContextV1.fromDomain(context);
      this.upsert.run(ContextV1.version, dto.name, dto.payload, dto.secrets);
      return success(undefined);
    } catch (cause) {
      return failure<void, ConcordError>(new PersistenceError(cause));
    }
  }

  public async delete(name: string): Promise<Result<void, ConcordError>> {
    try {
      this.deleteStatement.run(name);
      return success(undefined);
    } catch (cause) {
      return failure<void, ConcordError>(new PersistenceError(cause));
    }
  }

  public async list(query: ListQuery): Promise<ListResult<Context>> {
    const rows = this.selectList.all(query.limit, query.offset) as ContextRow[];
    const countRow = this.countAll.get() as CountRow;
    const items = rows.map((row) => this.rowToContext(row));
    return { items, total: countRow.total, limit: query.limit, offset: query.offset };
  }

  private rowToContext(row: ContextRow): Context {
    if (row.version === ContextV1.version) {
      const dto = new ContextV1(row.name, row.payload, row.secrets);
      return dto.toDomain();
    } else {
      throw new UnexpectedStateError(`Unknown context version: ${row.version}`);
    }
  }
}
