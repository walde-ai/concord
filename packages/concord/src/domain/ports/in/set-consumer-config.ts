import type { ConsumerDescriptor } from "../../component";
import type { ConsumerConfigValues } from "../../component";

export interface SetConsumerConfig {
  set(consumerId: string, values: ConsumerConfigValues): Promise<ConsumerDescriptor>;
}
