import { randomBytes } from "node:crypto";
import type { Statement } from "better-sqlite3";
import type { SessionStore, SessionValue } from "../../../../domain/ports/out/session-store";
import { SessionExpiredError } from "../../../../domain/exceptions/errors";
import type { SqliteDatabase } from "./sqlite-database";
import { SessionV1 } from "./dto/session-v1";

interface SessionRow {
  id: string;
  username: string;
  session_key: string;
  expires_at: string;
}

export class SqliteSessionStore implements SessionStore {
  private readonly insert: Statement;
  private readonly selectById: Statement;
  private readonly touchStatement: Statement;
  private readonly deleteExpired: Statement;

  public constructor(database: SqliteDatabase) {
    this.insert = database.prepare(
      "INSERT INTO sessions (version, id, username, session_key, expires_at) VALUES (?, ?, ?, ?, ?)",
    );
    this.selectById = database.prepare(
      "SELECT id, username, session_key, expires_at FROM sessions WHERE id = ?",
    );
    this.touchStatement = database.prepare(
      "UPDATE sessions SET expires_at = ? WHERE id = ?",
    );
    this.deleteExpired = database.prepare(
      "DELETE FROM sessions WHERE expires_at <= ?",
    );
  }

  public async create(value: SessionValue): Promise<string> {
    const id = randomBytes(32).toString("hex");
    this.insert.run(
      SessionV1.version,
      id,
      value.username,
      value.sessionKey,
      value.expiresAt.toISOString(),
    );
    return id;
  }

  public async get(id: string): Promise<SessionValue> {
    this.deleteExpired.run(new Date().toISOString());
    const row = this.selectById.get(id) as SessionRow | undefined;
    if (row === undefined) {
      throw new SessionExpiredError(id);
    }
    const dto = SessionV1.fromRow(row.id, row.username, row.session_key, row.expires_at);
    return {
      username: dto.username,
      sessionKey: dto.sessionKey,
      expiresAt: dto.expiresAt,
    };
  }

  public async touch(id: string, expiresAt: Date): Promise<void> {
    this.touchStatement.run(expiresAt.toISOString(), id);
  }
}
