import type { Event } from "../../entities/event";

export interface Rule<T> {
  decide(event: Event<T>): boolean;
}
