import { Event } from "../../../../../domain/entities/event";

export class EventV1 {
  public static readonly version = "v1";

  public constructor(
    public readonly id: string,
    public readonly producerId: string,
    public readonly producerEventId: string,
    public readonly datetime: string,
    public readonly type: string,
    public readonly payload: string,
    public readonly muted: boolean,
  ) {}

  public toDomain(): Event<unknown> {
    const event = new Event<unknown>(
      this.id,
      this.producerId,
      this.producerEventId,
      new Date(this.datetime),
      this.type,
      JSON.parse(this.payload),
    );
    if (this.muted) {
      event.markMuted();
    }
    return event;
  }

  public static fromDomain(event: Event<unknown>): EventV1 {
    return new EventV1(
      event.id,
      event.producerId,
      event.producerEventId,
      event.datetime.toISOString(),
      event.type,
      JSON.stringify(event.payload),
      event.muted,
    );
  }
}
