import type { ConsumerStateRepository } from "../../../domain/ports/out/consumer-state-repository";

export class InMemoryConsumerStateRepository implements ConsumerStateRepository {
  private readonly enabledStates: Map<string, boolean> = new Map();
  private readonly waitForOffPeakStates: Map<string, boolean> = new Map();

  public async get(consumerId: string): Promise<boolean> {
    return this.enabledStates.get(consumerId) ?? true;
  }

  public async setEnabled(consumerId: string, enabled: boolean): Promise<void> {
    this.enabledStates.set(consumerId, enabled);
  }

  public async getWaitForOffPeak(consumerId: string): Promise<boolean> {
    return this.waitForOffPeakStates.get(consumerId) ?? false;
  }

  public async setWaitForOffPeak(consumerId: string, flag: boolean): Promise<void> {
    this.waitForOffPeakStates.set(consumerId, flag);
  }
}
