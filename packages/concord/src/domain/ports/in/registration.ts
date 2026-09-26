import type { Producer } from "./producer";
import type { Consumer } from "../../entities/consumer";
import type { EventTemplate } from "./event-template";
import type { IdGenerator } from "../out/id-generator";
import type { Clock } from "../out/clock";
import type { ContextResolver } from "../out/context-resolver";

export interface Registration {
  addProducer(producer: Producer): void;
  addConsumer(consumer: Consumer<unknown>): void;
  addEventTemplate(template: EventTemplate): void;
  readonly idGenerator: IdGenerator;
  readonly clock: Clock;
  readonly contexts: ContextResolver;
}
