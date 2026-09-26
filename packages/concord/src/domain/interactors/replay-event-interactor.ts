import { Event } from "../entities/event";
import type { ReplayEvent } from "../ports/in/replay-event";
import type { EventSink } from "../ports/in/event-sink";
import type { EventStore } from "../ports/out/event-store";
import type { IdGenerator } from "../ports/out/id-generator";
import type { Clock } from "../ports/out/clock";
import { EventNotReplayableError } from "../exceptions/errors";
import { REPLAY_PRODUCER_ID } from "../../infra/adapters/replay/replay-producer-id";

export class ReplayEventInteractor implements ReplayEvent {
  public constructor(
    private readonly eventStore: EventStore,
    private readonly sink: EventSink,
    private readonly idGenerator: IdGenerator,
    private readonly clock: Clock,
  ) {}

  public async replay(eventId: string): Promise<Event<unknown>> {
    const source = await this.eventStore.getById(eventId);
    if (source.producerId === REPLAY_PRODUCER_ID) {
      throw new EventNotReplayableError(eventId);
    }
    const producerEventId = `${source.producerEventId}#${this.clock.now().getTime()}`;
    const replayed = new Event<unknown>(
      this.idGenerator.generate(),
      REPLAY_PRODUCER_ID,
      producerEventId,
      this.clock.now(),
      source.type,
      source.payload,
    );
    await this.sink.emit(replayed);
    return replayed;
  }
}
