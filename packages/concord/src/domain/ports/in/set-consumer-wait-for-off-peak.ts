import type { ConsumerDescriptor } from "../../component";

export interface SetConsumerWaitForOffPeak {
  set(consumerId: string, flag: boolean): Promise<ConsumerDescriptor>;
}
