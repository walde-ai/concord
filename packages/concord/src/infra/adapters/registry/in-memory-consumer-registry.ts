import type { ConsumerRegistry } from "../../../domain/ports/out/consumer-registry";
import type { Consumer } from "../../../domain/entities/consumer";

export class InMemoryConsumerRegistry implements ConsumerRegistry {
  private readonly consumers: Consumer<unknown>[] = [];

  public register(consumer: Consumer<unknown>): void {
    this.consumers.push(consumer);
  }

  public all(): Consumer<unknown>[] {
    return [...this.consumers];
  }
}
