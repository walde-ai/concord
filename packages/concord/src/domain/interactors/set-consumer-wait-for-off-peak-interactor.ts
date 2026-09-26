import type { SetConsumerWaitForOffPeak } from "../ports/in/set-consumer-wait-for-off-peak";
import type { ConsumerStateRepository } from "../ports/out/consumer-state-repository";
import type { ConsumerDescriptor } from "../component";
import type { ConsumerDescriptorBuilder } from "./consumer-descriptor-builder";

export class SetConsumerWaitForOffPeakInteractor implements SetConsumerWaitForOffPeak {
  public constructor(
    private readonly stateRepository: ConsumerStateRepository,
    private readonly descriptorBuilder: ConsumerDescriptorBuilder,
  ) {}

  public async set(consumerId: string, flag: boolean): Promise<ConsumerDescriptor> {
    await this.stateRepository.setWaitForOffPeak(consumerId, flag);
    return this.descriptorBuilder.build(consumerId);
  }
}
