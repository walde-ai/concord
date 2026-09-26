import type { ConsumerConfigResolver } from "../../../domain/ports/out/consumer-config-resolver";
import type { ConsumerConfigRepository } from "../../../domain/ports/out/consumer-config-repository";
import type { ConsumerRegistry } from "../../../domain/ports/out/consumer-registry";
import type { ConsumerConfigValues } from "../../../domain/component";

export class MergingConsumerConfigResolver implements ConsumerConfigResolver {
  public constructor(
    private readonly registry: ConsumerRegistry,
    private readonly repository: ConsumerConfigRepository,
  ) {}

  public async resolve(consumerId: string): Promise<ConsumerConfigValues> {
    const consumer = this.registry
      .all()
      .find((entry) => entry.consumerId === consumerId);
    if (consumer === undefined) {
      return {};
    }
    if (consumer.configSchema.length === 0) {
      return {};
    }
    const persisted = await this.repository.get(consumerId);
    const merged: ConsumerConfigValues = {};
    for (const parameter of consumer.configSchema) {
      const stored = persisted[parameter.key];
      if (typeof stored === "string" && stored.length > 0) {
        merged[parameter.key] = stored;
      } else {
        merged[parameter.key] = parameter.defaultValue;
      }
    }
    return merged;
  }
}
