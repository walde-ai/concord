import type { ListConsumers } from "../ports/in/list-consumers";
import type { ConsumerRegistry } from "../ports/out/consumer-registry";
import type { ConsumerDescriptor } from "../component";
import type { ConsumerDescriptorBuilder } from "./consumer-descriptor-builder";

export class ListConsumersInteractor implements ListConsumers {
  public constructor(
    private readonly registry: ConsumerRegistry,
    private readonly descriptorBuilder: ConsumerDescriptorBuilder,
  ) {}

  public async list(): Promise<ConsumerDescriptor[]> {
    const consumers = this.registry.all();
    return Promise.all(
      consumers.map((consumer) => this.descriptorBuilder.build(consumer.consumerId)),
    );
  }
}
