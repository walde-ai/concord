export interface SetConsumerEnabled {
  setEnabled(consumerId: string, enabled: boolean): Promise<void>;
}
