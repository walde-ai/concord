import type { EventDescriptor } from "../../event-descriptor";

export interface EmitEventResult {
  readonly descriptor: EventDescriptor;
}

export interface EmitEvent {
  emit(type: string, payload: unknown, producerId: string): Promise<EventDescriptor>;
}
