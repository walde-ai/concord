import type { Event } from "../entities/event";
import type { Consumer } from "../entities/consumer";
import type { EventSink } from "../ports/in/event-sink";
import type { EventStore } from "../ports/out/event-store";
import type { RunRepository } from "../ports/out/run-repository";
import type { ConsumerRegistry } from "../ports/out/consumer-registry";
import type { ProducerStateRepository } from "../ports/out/producer-state-repository";
import type { ConsumerStateRepository } from "../ports/out/consumer-state-repository";
import type { IdGenerator } from "../ports/out/id-generator";
import type { Clock } from "../ports/out/clock";
import type { EventLifecycleObserver } from "../ports/out/event-lifecycle-observer";
import type { PauseStateRepository } from "../ports/out/pause-state-repository";
import type { RunDispatcher } from "./run-dispatcher";

export class SignalEventInteractor implements EventSink {
  public constructor(
    private readonly eventStore: EventStore,
    private readonly runRepository: RunRepository,
    private readonly consumerRegistry: ConsumerRegistry,
    private readonly producerStateRepository: ProducerStateRepository,
    private readonly consumerStateRepository: ConsumerStateRepository,
    private readonly idGenerator: IdGenerator,
    private readonly clock: Clock,
    private readonly observer: EventLifecycleObserver,
    private readonly pauseStateRepository: PauseStateRepository,
    private readonly runDispatcher: RunDispatcher,
  ) {}

  public async emit(event: Event<unknown>): Promise<void> {
    const dispatchable = await this.prepareEvent(event);
    if (dispatchable === null) {
      return;
    }
    await Promise.all(dispatchable.map((consumer) => this.runDispatcher.dispatch(event, consumer)));
  }

  public async emitDetached(event: Event<unknown>): Promise<void> {
    const dispatchable = await this.prepareEvent(event);
    if (dispatchable === null) {
      return;
    }
    // dispatchDetached saves each matching run (so the event is durably
    // recorded alongside its runs before this resolves) but executes the
    // handlers on the dispatcher's detached track, so the emitting run is not
    // held in RUNNING until these downstream runs complete. awaiting the
    // prepareRun step (which dispatchDetached does internally) is what guards
    // the durability guarantee; we deliberately do NOT await execute.
    await Promise.all(dispatchable.map((consumer) => this.runDispatcher.dispatchDetached(event, consumer)));
  }

  // Deduplicates the event by (producerId, producerEventId), applies the
  // producer/pause mute rules, persists the event, notifies observers, and
  // resolves to the set of enabled consumers whose rules match. Returns null
  // when the event is a duplicate or is muted, so callers can short-circuit
  // without dispatching.
  private async prepareEvent(event: Event<unknown>): Promise<Consumer<unknown>[] | null> {
    if (await this.eventStore.existsByProducerKey(event.producerId, event.producerEventId)) {
      return null;
    }

    const producerEnabled = await this.producerStateRepository.get(event.producerId);
    if (!producerEnabled) {
      event.markMuted();
    }

    const paused = await this.pauseStateRepository.isPaused();
    if (paused) {
      event.markMuted();
    }

    await this.eventStore.save(event);
    this.observer.eventCreated(event);

    if (event.muted) {
      return null;
    }

    const consumers = this.consumerRegistry.all();
    const matching = consumers.filter((consumer) => consumer.rule.decide(event));
    return this.filterEnabled(matching);
  }

  private async filterEnabled(consumers: Consumer<unknown>[]): Promise<Consumer<unknown>[]> {
    const checked = await Promise.all(
      consumers.map(async (consumer) => {
        const enabled = await this.consumerStateRepository.get(consumer.consumerId);
        return { consumer, enabled };
      }),
    );
    return checked.filter((entry) => entry.enabled).map((entry) => entry.consumer);
  }
}
