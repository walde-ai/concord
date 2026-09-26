import type { ConsumerSecretResolver } from "../../../domain/ports/out/consumer-secret-resolver";
import type { ConsumerConfigRepository } from "../../../domain/ports/out/consumer-config-repository";
import type { ConsumerRegistry } from "../../../domain/ports/out/consumer-registry";
import type { ConsumerConfigSecrets } from "../../../domain/component";

export class RepositoryConsumerSecretResolver implements ConsumerSecretResolver {
  public constructor(
    private readonly registry: ConsumerRegistry,
    private readonly repository: ConsumerConfigRepository,
  ) {}

  public async resolveSecrets(consumerId: string): Promise<ConsumerConfigSecrets> {
    const consumer = this.registry
      .all()
      .find((entry) => entry.consumerId === consumerId);
    if (consumer === undefined) {
      return {};
    }
    if (consumer.secretSchema.length === 0) {
      return {};
    }
    return this.repository.getSecrets(consumerId);
  }
}
