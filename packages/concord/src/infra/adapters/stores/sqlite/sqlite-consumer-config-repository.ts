import type { Statement } from "better-sqlite3";
import type { ConsumerConfigRepository } from "../../../../domain/ports/out/consumer-config-repository";
import type { ConsumerConfigSecrets, ConsumerConfigValues } from "../../../../domain/component";
import type { SecretOperation } from "../../../../domain/context";
import type { SqliteDatabase } from "./sqlite-database";
import { ConsumerConfigV1 } from "./dto/consumer-config-v1";

interface ConsumerConfigRow {
  values_json: string;
  secrets_json: string;
}

export class SqliteConsumerConfigRepository implements ConsumerConfigRepository {
  private readonly upsert: Statement;
  private readonly selectById: Statement;

  public constructor(database: SqliteDatabase) {
    this.upsert = database.prepare(
      "INSERT OR REPLACE INTO consumer_configs (version, consumer_id, values_json, secrets_json) VALUES (?, ?, ?, ?)",
    );
    this.selectById = database.prepare(
      "SELECT values_json, secrets_json FROM consumer_configs WHERE consumer_id = ?",
    );
  }

  public async get(consumerId: string): Promise<ConsumerConfigValues> {
    const row = this.selectById.get(consumerId) as ConsumerConfigRow | undefined;
    if (row === undefined) {
      return {};
    }
    return ConsumerConfigV1.fromRow(consumerId, row.values_json, row.secrets_json).values;
  }

  public async set(consumerId: string, values: ConsumerConfigValues): Promise<void> {
    const current = this.readRow(consumerId);
    const dto = ConsumerConfigV1.fromDomain(consumerId, values, current.secrets);
    this.upsert.run(ConsumerConfigV1.version, consumerId, dto.toValuesJson(), dto.toSecretsJson());
  }

  public async getSecrets(consumerId: string): Promise<ConsumerConfigSecrets> {
    const row = this.selectById.get(consumerId) as ConsumerConfigRow | undefined;
    if (row === undefined) {
      return {};
    }
    return ConsumerConfigV1.fromRow(consumerId, row.values_json, row.secrets_json).secrets;
  }

  public async applySecretOperation(consumerId: string, operation: SecretOperation): Promise<void> {
    const current = this.readRow(consumerId);
    const merged: ConsumerConfigSecrets = { ...current.secrets };
    for (const upsert of operation.upserts) {
      merged[upsert.name] = upsert.value;
    }
    for (const name of operation.deletes) {
      delete merged[name];
    }
    const dto = ConsumerConfigV1.fromDomain(consumerId, current.values, merged);
    this.upsert.run(ConsumerConfigV1.version, consumerId, dto.toValuesJson(), dto.toSecretsJson());
  }

  private readRow(consumerId: string): { readonly values: ConsumerConfigValues; readonly secrets: ConsumerConfigSecrets } {
    const row = this.selectById.get(consumerId) as ConsumerConfigRow | undefined;
    if (row === undefined) {
      return { values: {}, secrets: {} };
    }
    const dto = ConsumerConfigV1.fromRow(consumerId, row.values_json, row.secrets_json);
    return { values: dto.values, secrets: dto.secrets };
  }
}
