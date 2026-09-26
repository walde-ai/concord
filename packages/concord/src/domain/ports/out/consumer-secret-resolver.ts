import type { ConsumerConfigSecrets } from "../../component";

export interface ConsumerSecretResolver {
  resolveSecrets(consumerId: string): Promise<ConsumerConfigSecrets>;
}
