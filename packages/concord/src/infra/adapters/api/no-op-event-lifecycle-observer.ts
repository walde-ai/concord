import type { EventLifecycleObserver } from "../../../domain/ports/out/event-lifecycle-observer";
import type { PeakHours } from "../../../domain/peak-hours";

export class NoOpEventLifecycleObserver implements EventLifecycleObserver {
  public eventCreated(): void {}

  public runCreated(): void {}

  public runStateChanged(): void {}

  public pausedChanged(): void {}

  public peakHoursChanged(_peakHours: PeakHours | null): void {}
}
