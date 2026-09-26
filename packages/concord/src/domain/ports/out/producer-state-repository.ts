export interface ProducerStateRepository {
  get(producerId: string): Promise<boolean>;
  setEnabled(producerId: string, enabled: boolean): Promise<void>;
}
