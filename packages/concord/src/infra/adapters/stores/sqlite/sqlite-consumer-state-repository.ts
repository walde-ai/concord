import type { Statement } from "better-sqlite3";
import type { ConsumerStateRepository } from "../../../../domain/ports/out/consumer-state-repository";
import type { SqliteDatabase } from "./sqlite-database";
import { ConsumerStateV1 } from "./dto/consumer-state-v1";

interface ConsumerStateRow {
  enabled: number;
  wait_for_off_peak: number;
}

export class SqliteConsumerStateRepository implements ConsumerStateRepository {
  private readonly upsert: Statement;
  private readonly selectById: Statement;

  public constructor(database: SqliteDatabase) {
    this.upsert = database.prepare(
      "INSERT OR REPLACE INTO consumer_states (version, id, enabled, wait_for_off_peak) VALUES (?, ?, ?, ?)",
    );
    this.selectById = database.prepare(
      "SELECT enabled, wait_for_off_peak FROM consumer_states WHERE id = ?",
    );
  }

  public async get(consumerId: string): Promise<boolean> {
    const row = this.selectById.get(consumerId) as ConsumerStateRow | undefined;
    if (row === undefined) {
      return true;
    }
    return ConsumerStateV1.fromRow(consumerId, row.enabled, row.wait_for_off_peak).enabled;
  }

  public async setEnabled(consumerId: string, enabled: boolean): Promise<void> {
    const current = await this.readRow(consumerId);
    const dto = ConsumerStateV1.fromRow(consumerId, enabled ? 1 : 0, current.wait_for_off_peak);
    this.write(dto, consumerId);
  }

  public async getWaitForOffPeak(consumerId: string): Promise<boolean> {
    const row = await this.readRow(consumerId);
    return ConsumerStateV1.fromRow(consumerId, row.enabled, row.wait_for_off_peak).waitForOffPeak;
  }

  public async setWaitForOffPeak(consumerId: string, flag: boolean): Promise<void> {
    const current = await this.readRow(consumerId);
    const dto = ConsumerStateV1.fromRow(consumerId, current.enabled, flag ? 1 : 0);
    this.write(dto, consumerId);
  }

  private async readRow(consumerId: string): Promise<ConsumerStateRow> {
    const row = this.selectById.get(consumerId) as ConsumerStateRow | undefined;
    if (row === undefined) {
      return { enabled: 1, wait_for_off_peak: 0 };
    }
    return row;
  }

  private write(dto: ConsumerStateV1, consumerId: string): void {
    const row = dto.toRow();
    this.upsert.run(ConsumerStateV1.version, consumerId, row.enabled, row.waitForOffPeak);
  }
}
