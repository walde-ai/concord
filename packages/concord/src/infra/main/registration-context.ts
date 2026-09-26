import type { Registration } from "../../domain/ports/in/registration";
import type { Producer } from "../../domain/ports/in/producer";
import type { Consumer } from "../../domain/entities/consumer";
import type { EventTemplate } from "../../domain/ports/in/event-template";
import type { IdGenerator } from "../../domain/ports/out/id-generator";
import type { Clock } from "../../domain/ports/out/clock";
import type { ContextResolver } from "../../domain/ports/out/context-resolver";

export class RegistrationContext implements Registration {
  private readonly collectedProducers: Producer[] = [];
  private readonly collectedConsumers: Consumer<unknown>[] = [];
  private readonly collectedEventTemplates: EventTemplate[] = [];

  public constructor(
    public readonly idGenerator: IdGenerator,
    public readonly clock: Clock,
    public readonly contexts: ContextResolver,
  ) {}

  public addProducer(producer: Producer): void {
    this.collectedProducers.push(producer);
  }

  public addConsumer(consumer: Consumer<unknown>): void {
    this.collectedConsumers.push(consumer);
  }

  public addEventTemplate(template: EventTemplate): void {
    this.collectedEventTemplates.push(template);
  }

  public get producers(): readonly Producer[] {
    return this.collectedProducers;
  }

  public get consumers(): readonly Consumer<unknown>[] {
    return this.collectedConsumers;
  }

  public get eventTemplates(): readonly EventTemplate[] {
    return this.collectedEventTemplates;
  }
}
