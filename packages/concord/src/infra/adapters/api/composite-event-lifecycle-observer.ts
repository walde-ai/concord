import type { EventLifecycleObserver } from "../../../domain/ports/out/event-lifecycle-observer";
import type { Event } from "../../../domain/entities/event";
import type { Run } from "../../../domain/entities/run";
import type { PeakHours } from "../../../domain/peak-hours";

export class CompositeEventLifecycleObserver implements EventLifecycleObserver {
  private readonly observers: EventLifecycleObserver[] = [];

  public add(observer: EventLifecycleObserver): void {
    this.observers.push(observer);
  }

  public eventCreated(event: Event<unknown>): void {
    for (const observer of this.observers) {
      observer.eventCreated(event);
    }
  }

  public runCreated(run: Run<unknown>): void {
    for (const observer of this.observers) {
      observer.runCreated(run);
    }
  }

  public runStateChanged(run: Run<unknown>): void {
    for (const observer of this.observers) {
      observer.runStateChanged(run);
    }
  }

  public pausedChanged(paused: boolean): void {
    for (const observer of this.observers) {
      observer.pausedChanged(paused);
    }
  }

  public peakHoursChanged(peakHours: PeakHours | null): void {
    for (const observer of this.observers) {
      observer.peakHoursChanged(peakHours);
    }
  }
}
