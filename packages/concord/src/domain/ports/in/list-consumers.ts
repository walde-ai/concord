import type { ConsumerDescriptor } from "../../component";

export interface ListConsumers {
  list(): Promise<ConsumerDescriptor[]>;
}
