export interface RegisteredProducer {
  readonly producerId: string;
  readonly disableable: boolean;
}

export interface ProducerRegistry {
  all(): RegisteredProducer[];
}
