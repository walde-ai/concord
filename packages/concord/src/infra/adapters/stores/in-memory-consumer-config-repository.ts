import type { ConsumerConfigRepository } from "../../../domain/ports/out/consumer-config-repository";
import type { ConsumerConfigSecrets, ConsumerConfigValues } from "../../../domain/component";
import type { SecretOperation } from "../../../domain/context";

export class InMemoryConsumerConfigRepository implements ConsumerConfigRepository {
  private readonly valuesByConsumer: Map<string, ConsumerConfigValues> = new Map();
  private readonly secretsByConsumer: Map<string, ConsumerConfigSecrets> = new Map();

  public async get(consumerId: string): Promise<ConsumerConfigValues> {
    return this.valuesByConsumer.get(consumerId) ?? {};
  }

  public async set(consumerId: string, values: ConsumerConfigValues): Promise<void> {
    this.valuesByConsumer.set(consumerId, { ...values });
  }

  public async getSecrets(consumerId: string): Promise<ConsumerConfigSecrets> {
    return this.secretsByConsumer.get(consumerId) ?? {};
  }

  public async applySecretOperation(consumerId: string, operation: SecretOperation): Promise<void> {
    const current = this.secretsByConsumer.get(consumerId) ?? {};
    const merged: ConsumerConfigSecrets = { ...current };
    for (const upsert of operation.upserts) {
      merged[upsert.name] = upsert.value;
    }
    for (const name of operation.deletes) {
      delete merged[name];
    }
    this.secretsByConsumer.set(consumerId, merged);
  }
}
