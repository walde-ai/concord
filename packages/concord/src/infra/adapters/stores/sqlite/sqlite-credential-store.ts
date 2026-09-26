import type { Statement } from "better-sqlite3";
import type { CredentialStore } from "../../../../domain/ports/out/credential-store";
import type { Credential } from "../../../../domain/entities/credential";
import type { Result } from "../../../../domain/result";
import { success, failure } from "../../../../domain/result";
import type { ConcordError } from "../../../../domain/exceptions/errors";
import {
  PersistenceError,
  UnexpectedStateError,
  UserNotFoundError,
} from "../../../../domain/exceptions/errors";
import type { SqliteDatabase } from "./sqlite-database";
import { CredentialV1 } from "./dto/credential-v1";

interface CredentialRow {
  version: string;
  username: string;
  salt: string;
  verifier: string;
}

export class SqliteCredentialStore implements CredentialStore {
  private readonly selectByUsername: Statement;
  private readonly existsStatement: Statement;
  private readonly upsert: Statement;
  private readonly deleteStatement: Statement;

  public constructor(database: SqliteDatabase) {
    this.selectByUsername = database.prepare(
      "SELECT version, username, salt, verifier FROM credentials WHERE username = ?",
    );
    this.existsStatement = database.prepare(
      "SELECT 1 FROM credentials WHERE username = ?",
    );
    this.upsert = database.prepare(
      "INSERT OR REPLACE INTO credentials (version, username, salt, verifier) VALUES (?, ?, ?, ?)",
    );
    this.deleteStatement = database.prepare(
      "DELETE FROM credentials WHERE username = ?",
    );
  }

  public async getByName(username: string): Promise<Credential> {
    const row = this.selectByUsername.get(username) as CredentialRow | undefined;
    if (row === undefined) {
      throw new UserNotFoundError(username);
    }
    return this.rowToCredential(row);
  }

  public async exists(username: string): Promise<boolean> {
    const row = this.existsStatement.get(username);
    return row !== undefined;
  }

  public async save(credential: Credential): Promise<Result<void, ConcordError>> {
    try {
      const dto = CredentialV1.fromDomain(credential);
      this.upsert.run(CredentialV1.version, dto.username, dto.salt, dto.verifier);
      return success(undefined);
    } catch (cause) {
      return failure<void, ConcordError>(new PersistenceError(cause));
    }
  }

  public async delete(username: string): Promise<Result<void, ConcordError>> {
    try {
      this.deleteStatement.run(username);
      return success(undefined);
    } catch (cause) {
      return failure<void, ConcordError>(new PersistenceError(cause));
    }
  }

  private rowToCredential(row: CredentialRow): Credential {
    if (row.version === CredentialV1.version) {
      const dto = new CredentialV1(row.username, row.salt, row.verifier);
      return dto.toDomain();
    } else {
      throw new UnexpectedStateError(`Unknown credential version: ${row.version}`);
    }
  }
}
