import type { Statement } from "better-sqlite3";
import type { PauseStateRepository } from "../../../../domain/ports/out/pause-state-repository";
import type { SqliteDatabase } from "./sqlite-database";
import { PauseStateV1 } from "./dto/pause-state-v1";

const PAUSE_STATE_ROW_ID = 1;

interface PauseStateRow {
  paused: number;
}

export class SqlitePauseStateRepository implements PauseStateRepository {
  private readonly upsert: Statement;
  private readonly selectById: Statement;

  public constructor(database: SqliteDatabase) {
    this.upsert = database.prepare(
      "INSERT OR REPLACE INTO pause_state (version, id, paused) VALUES (?, ?, ?)",
    );
    this.selectById = database.prepare(
      "SELECT paused FROM pause_state WHERE id = ?",
    );
  }

  public async isPaused(): Promise<boolean> {
    const row = this.selectById.get(PAUSE_STATE_ROW_ID) as PauseStateRow | undefined;
    if (row === undefined) {
      return false;
    }
    return PauseStateV1.fromRow(PAUSE_STATE_ROW_ID, row.paused).paused;
  }

  public async setPaused(paused: boolean): Promise<void> {
    const dto = new PauseStateV1(PAUSE_STATE_ROW_ID, paused);
    const row = dto.toRow();
    this.upsert.run(PauseStateV1.version, PAUSE_STATE_ROW_ID, row.paused);
  }
}
