import type { Producer } from "../../../../domain/ports/in/producer";
import type { EventSink } from "../../../../domain/ports/in/event-sink";
import type { Registration } from "../../../../domain/ports/in/registration";
import { Event } from "../../../../domain/entities/event";
import type { IdGenerator } from "../../../../domain/ports/out/id-generator";
import type { Clock } from "../../../../domain/ports/out/clock";
import { UnexpectedStateError } from "../../../../domain/exceptions/errors";

export class InlineProducer implements Producer {
  private idGenerator: IdGenerator | null = null;
  private clock: Clock | null = null;
  private sink: EventSink | null = null;

  public constructor(public readonly producerId: string) {}

  public register(registration: Registration): void {
    this.idGenerator = registration.idGenerator;
    this.clock = registration.clock;
    registration.addProducer(this);
  }

  public async start(sink: EventSink): Promise<void> {
    this.sink = sink;
  }

  public async stop(): Promise<void> {
    this.sink = null;
  }

  public async emit(producerEventId: string, type: string, payload: unknown): Promise<void> {
    const idGenerator = this.idGenerator;
    const clock = this.clock;
    const sink = this.sink;
    if (idGenerator === null || clock === null) {
      throw new UnexpectedStateError(`InlineProducer "${this.producerId}" has not been registered`);
    }
    if (sink === null) {
      throw new UnexpectedStateError(`InlineProducer "${this.producerId}" has not been started`);
    }
    const event = new Event<unknown>(idGenerator.generate(), this.producerId, producerEventId, clock.now(), type, payload);
    // An InlineProducer is emitted from inside a run handler. Awaiting
    // sink.emit() here would hold the emitting run in RUNNING until every
    // transitively-triggered downstream run reaches a terminal state, which
    // both misrepresents the emitting run's lifetime AND makes it un-abortable
    // (its AbortSignal cannot reach the downstream runs). emitDetached stores
    // the event and prepares the matching runs before resolving, but lets the
    // handlers execute independently on the dispatcher's detached track.
    await sink.emitDetached(event);
  }
}
