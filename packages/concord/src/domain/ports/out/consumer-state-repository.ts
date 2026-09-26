export interface ConsumerStateRepository {
  get(consumerId: string): Promise<boolean>;
  setEnabled(consumerId: string, enabled: boolean): Promise<void>;
  getWaitForOffPeak(consumerId: string): Promise<boolean>;
  setWaitForOffPeak(consumerId: string, flag: boolean): Promise<void>;
}
