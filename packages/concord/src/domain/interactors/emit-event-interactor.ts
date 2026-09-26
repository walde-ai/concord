import type { EmitEvent, EmitEventResult } from "../ports/in/emit-event";
import type { EventSink } from "../ports/in/event-sink";
import type { IdGenerator } from "../ports/out/id-generator";
import type { Clock } from "../ports/out/clock";
import type { EventDescriptor } from "../event-descriptor";
import { Event } from "../entities/event";

export class EmitEventInteractor implements EmitEvent {
  public constructor(
    private readonly sink: EventSink,
    private readonly idGenerator: IdGenerator,
    private readonly clock: Clock,
  ) {}

  public async emit(type: string, payload: unknown, producerId: string): Promise<EventDescriptor> {
    const id = this.idGenerator.generate();
    const datetime = this.clock.now();
    const event = new Event<unknown>(id, producerId, id, datetime, type, payload);
    await this.sink.emit(event);
    return {
      id,
      producerId,
      producerEventId: id,
      datetime,
      type,
      payload,
    };
  }
}
