import type { ProducerRegistry, RegisteredProducer } from "../../../domain/ports/out/producer-registry";

export class InMemoryProducerRegistry implements ProducerRegistry {
  private readonly producers: RegisteredProducer[] = [];

  public register(producer: RegisteredProducer): void {
    this.producers.push(producer);
  }

  public all(): RegisteredProducer[] {
    return [...this.producers];
  }
}
