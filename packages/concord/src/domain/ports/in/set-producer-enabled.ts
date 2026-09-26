export interface SetProducerEnabled {
  setEnabled(producerId: string, enabled: boolean): Promise<void>;
}
