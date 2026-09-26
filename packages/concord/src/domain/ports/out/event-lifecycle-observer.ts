import type { Event } from "../../entities/event";
import type { Run } from "../../entities/run";
import type { PeakHours } from "../../peak-hours";

export interface EventLifecycleObserver {
  eventCreated(event: Event<unknown>): void;
  runCreated(run: Run<unknown>): void;
  runStateChanged(run: Run<unknown>): void;
  pausedChanged(paused: boolean): void;
  peakHoursChanged(peakHours: PeakHours | null): void;
}
