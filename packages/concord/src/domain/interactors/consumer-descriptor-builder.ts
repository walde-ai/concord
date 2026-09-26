import type { ConsumerRegistry } from "../ports/out/consumer-registry";
import type { ConsumerStateRepository } from "../ports/out/consumer-state-repository";
import type { ConsumerConfigResolver } from "../ports/out/consumer-config-resolver";
import type { ConsumerSecretResolver } from "../ports/out/consumer-secret-resolver";
import { ConsumerNotFoundError } from "../exceptions/errors";
import type { ConsumerDescriptor } from "../component";

export class ConsumerDescriptorBuilder {
  public constructor(
    private readonly registry: ConsumerRegistry,
    private readonly stateRepository: ConsumerStateRepository,
    private readonly configResolver: ConsumerConfigResolver,
    private readonly secretResolver: ConsumerSecretResolver,
  ) {}

  public async build(consumerId: string): Promise<ConsumerDescriptor> {
    const consumer = this.registry
      .all()
      .find((entry) => entry.consumerId === consumerId);
    if (consumer === undefined) {
      throw new ConsumerNotFoundError(consumerId);
    }
    const [enabled, waitForOffPeak, configValues, secrets] = await Promise.all([
      this.stateRepository.get(consumer.consumerId),
      this.stateRepository.getWaitForOffPeak(consumer.consumerId),
      this.configResolver.resolve(consumer.consumerId),
      this.secretResolver.resolveSecrets(consumer.consumerId),
    ]);
    return {
      consumerId: consumer.consumerId,
      enabled,
      waitForOffPeak,
      configParameters: consumer.configSchema,
      configValues,
      secretParameters: consumer.secretSchema,
      secretNames: Object.keys(secrets).sort(),
    };
  }
}
