import type { ConsumerDescriptor } from "../../component";
import type { SecretOperation } from "../../context";

export interface SetConsumerSecrets {
  set(consumerId: string, operation: SecretOperation): Promise<ConsumerDescriptor>;
}
