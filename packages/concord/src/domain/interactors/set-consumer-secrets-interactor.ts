import type { SetConsumerSecrets } from "../ports/in/set-consumer-secrets";
import type { ConsumerRegistry } from "../ports/out/consumer-registry";
import type { ConsumerConfigRepository } from "../ports/out/consumer-config-repository";
import type { SecretOperation } from "../context";
import type { ConsumerDescriptor } from "../component";
import { ConsumerNotFoundError, InvalidConsumerConfigError } from "../exceptions/errors";
import type { ConsumerDescriptorBuilder } from "./consumer-descriptor-builder";

export class SetConsumerSecretsInteractor implements SetConsumerSecrets {
  public constructor(
    private readonly registry: ConsumerRegistry,
    private readonly repository: ConsumerConfigRepository,
    private readonly descriptorBuilder: ConsumerDescriptorBuilder,
  ) {}

  public async set(consumerId: string, operation: SecretOperation): Promise<ConsumerDescriptor> {
    const consumer = this.registry
      .all()
      .find((entry) => entry.consumerId === consumerId);
    if (consumer === undefined) {
      throw new ConsumerNotFoundError(consumerId);
    }
    const allowedKeys = new Set(consumer.secretSchema.map((parameter) => parameter.key));
    for (const upsert of operation.upserts) {
      if (!allowedKeys.has(upsert.name)) {
        throw new InvalidConsumerConfigError(`Secret "${upsert.name}" is not declared on consumer "${consumerId}"`);
      }
    }
    for (const name of operation.deletes) {
      if (!allowedKeys.has(name)) {
        throw new InvalidConsumerConfigError(`Secret "${name}" is not declared on consumer "${consumerId}"`);
      }
    }
    await this.repository.applySecretOperation(consumerId, operation);
    return this.descriptorBuilder.build(consumerId);
  }
}
