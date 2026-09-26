import type { SetConsumerEnabled } from "../ports/in/set-consumer-enabled";
import type { ConsumerRegistry } from "../ports/out/consumer-registry";
import type { ConsumerStateRepository } from "../ports/out/consumer-state-repository";
import { ConsumerNotFoundError } from "../exceptions/errors";

export class SetConsumerEnabledInteractor implements SetConsumerEnabled {
  public constructor(
    private readonly registry: ConsumerRegistry,
    private readonly stateRepository: ConsumerStateRepository,
  ) {}

  public async setEnabled(consumerId: string, enabled: boolean): Promise<void> {
    if (!this.isRegistered(consumerId)) {
      throw new ConsumerNotFoundError(consumerId);
    }
    await this.stateRepository.setEnabled(consumerId, enabled);
  }

  private isRegistered(consumerId: string): boolean {
    return this.registry.all().some((consumer) => consumer.consumerId === consumerId);
  }
}
