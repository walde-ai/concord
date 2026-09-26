import type { Event } from "../../entities/event";

export interface EventSink {
  emit(event: Event<unknown>): Promise<void>;
  // Emits an event without waiting for the matching consumers' runs to reach a
  // terminal state. The event is stored and the matching consumers' runs are
  // prepared (saved) before this resolves, but the handlers execute on the
  // dispatcher's detached track. Use this from inside a run handler (via the
  // InlineProducer) so the emitting run is not held in RUNNING until every
  // transitively-triggered run completes — that coupling would make the
  // emitting run un-abortable (its AbortSignal cannot reach the downstream
  // runs) and would misreport the emitting run's lifetime as the union of all
  // downstream runs.
  emitDetached(event: Event<unknown>): Promise<void>;
}
