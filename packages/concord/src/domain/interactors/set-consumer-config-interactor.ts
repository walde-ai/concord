import type { SetConsumerConfig } from "../ports/in/set-consumer-config";
import type { ConsumerConfigValues } from "../component";
import type { ConsumerRegistry } from "../ports/out/consumer-registry";
import type { ConsumerConfigRepository } from "../ports/out/consumer-config-repository";
import { ConsumerNotFoundError, InvalidConsumerConfigError } from "../exceptions/errors";
import type { ConsumerDescriptor } from "../component";
import type { ConsumerDescriptorBuilder } from "./consumer-descriptor-builder";

export class SetConsumerConfigInteractor implements SetConsumerConfig {
  public constructor(
    private readonly registry: ConsumerRegistry,
    private readonly repository: ConsumerConfigRepository,
    private readonly descriptorBuilder: ConsumerDescriptorBuilder,
  ) {}

  public async set(consumerId: string, values: ConsumerConfigValues): Promise<ConsumerDescriptor> {
    const consumer = this.registry
      .all()
      .find((entry) => entry.consumerId === consumerId);
    if (consumer === undefined) {
      throw new ConsumerNotFoundError(consumerId);
    }
    const allowedKeys = new Set(consumer.configSchema.map((parameter) => parameter.key));
    for (const key of Object.keys(values)) {
      if (!allowedKeys.has(key)) {
        throw new InvalidConsumerConfigError(`Key "${key}" is not declared on consumer "${consumerId}"`);
      }
    }
    await this.repository.set(consumerId, values);
    return this.descriptorBuilder.build(consumerId);
  }
}
