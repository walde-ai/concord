import type { ConsumerConfigSecrets, ConsumerConfigValues } from "../../component";
import type { SecretOperation } from "../../context";

export interface ConsumerConfigRepository {
  get(consumerId: string): Promise<ConsumerConfigValues>;
  set(consumerId: string, values: ConsumerConfigValues): Promise<void>;
  getSecrets(consumerId: string): Promise<ConsumerConfigSecrets>;
  applySecretOperation(consumerId: string, operation: SecretOperation): Promise<void>;
}
