import type { SetProducerEnabled } from "../ports/in/set-producer-enabled";
import type { ProducerRegistry } from "../ports/out/producer-registry";
import type { ProducerStateRepository } from "../ports/out/producer-state-repository";
import { ProducerNotFoundError, ProducerNotDisableableError } from "../exceptions/errors";

export class SetProducerEnabledInteractor implements SetProducerEnabled {
  public constructor(
    private readonly registry: ProducerRegistry,
    private readonly stateRepository: ProducerStateRepository,
  ) {}

  public async setEnabled(producerId: string, enabled: boolean): Promise<void> {
    const descriptor = this.registry.all().find((item) => item.producerId === producerId);
    if (descriptor === undefined) {
      throw new ProducerNotFoundError(producerId);
    }
    if (!descriptor.disableable) {
      throw new ProducerNotDisableableError(producerId);
    }
    await this.stateRepository.setEnabled(producerId, enabled);
  }
}
