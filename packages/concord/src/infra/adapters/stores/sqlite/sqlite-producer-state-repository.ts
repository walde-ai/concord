import type { Statement } from "better-sqlite3";
import type { ProducerStateRepository } from "../../../../domain/ports/out/producer-state-repository";
import type { SqliteDatabase } from "./sqlite-database";
import { ProducerStateV1 } from "./dto/producer-state-v1";

interface ProducerStateRow {
  enabled: number;
}

export class SqliteProducerStateRepository implements ProducerStateRepository {
  private readonly upsert: Statement;
  private readonly selectById: Statement;

  public constructor(database: SqliteDatabase) {
    this.upsert = database.prepare(
      "INSERT OR REPLACE INTO producer_states (version, id, enabled) VALUES (?, ?, ?)",
    );
    this.selectById = database.prepare(
      "SELECT enabled FROM producer_states WHERE id = ?",
    );
  }

  public async get(producerId: string): Promise<boolean> {
    const row = this.selectById.get(producerId) as ProducerStateRow | undefined;
    if (row === undefined) {
      return true;
    }
    return ProducerStateV1.fromRow(producerId, row.enabled).enabled;
  }

  public async setEnabled(producerId: string, enabled: boolean): Promise<void> {
    const dto = ProducerStateV1.fromRow(producerId, enabled ? 1 : 0);
    const row = dto.toRow();
    this.upsert.run(ProducerStateV1.version, producerId, row.enabled);
  }
}
