import type { Event } from "../../entities/event";

export interface ReplayEvent {
  replay(eventId: string): Promise<Event<unknown>>;
}
