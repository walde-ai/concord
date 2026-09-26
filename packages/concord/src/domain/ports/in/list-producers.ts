import type { ProducerDescriptor } from "../../component";

export interface ListProducers {
  list(): Promise<ProducerDescriptor[]>;
}
