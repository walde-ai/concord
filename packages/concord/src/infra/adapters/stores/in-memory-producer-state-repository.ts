import type { ProducerStateRepository } from "../../../domain/ports/out/producer-state-repository";

export class InMemoryProducerStateRepository implements ProducerStateRepository {
  private readonly states: Map<string, boolean> = new Map();

  public async get(producerId: string): Promise<boolean> {
    return this.states.get(producerId) ?? true;
  }

  public async setEnabled(producerId: string, enabled: boolean): Promise<void> {
    this.states.set(producerId, enabled);
  }
}
