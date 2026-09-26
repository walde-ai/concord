import type { ConsumerConfigValues } from "../../component";

export interface ConsumerConfigResolver {
  resolve(consumerId: string): Promise<ConsumerConfigValues>;
}
