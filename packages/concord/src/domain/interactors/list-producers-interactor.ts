import type { ListProducers } from "../ports/in/list-producers";
import type { ProducerRegistry } from "../ports/out/producer-registry";
import type { ProducerStateRepository } from "../ports/out/producer-state-repository";
import type { ProducerDescriptor } from "../component";

export class ListProducersInteractor implements ListProducers {
  public constructor(
    private readonly registry: ProducerRegistry,
    private readonly stateRepository: ProducerStateRepository,
  ) {}

  public async list(): Promise<ProducerDescriptor[]> {
    const descriptors = this.registry.all();
    return Promise.all(
      descriptors.map(async (descriptor) => {
        const enabled = await this.stateRepository.get(descriptor.producerId);
        return {
          producerId: descriptor.producerId,
          enabled,
          disableable: descriptor.disableable,
        };
      }),
    );
  }
}
