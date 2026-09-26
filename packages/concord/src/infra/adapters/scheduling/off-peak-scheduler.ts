import type { RunDispatcher } from "../../../domain/interactors/run-dispatcher";
import type { RunRepository } from "../../../domain/ports/out/run-repository";
import type { PeakHoursRepository } from "../../../domain/ports/out/peak-hours-repository";
import type { PeakSchedule } from "../../../domain/ports/out/peak-schedule";
import type { Clock } from "../../../domain/ports/out/clock";
import type { EventLifecycleObserver } from "../../../domain/ports/out/event-lifecycle-observer";
import type { PeakHours } from "../../../domain/peak-hours";
import type { Startable } from "../../main/startable";
import type { Closeable } from "../../main/closeable";

export interface SchedulerTimer {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const SYSTEM_TIMER: SchedulerTimer = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const DEFAULT_LIST_LIMIT = 1000;

export class OffPeakScheduler implements Startable, Closeable, EventLifecycleObserver {
  private timerHandle: unknown = null;
  private started = false;

  public constructor(
    private readonly dispatcher: RunDispatcher,
    private readonly runRepository: RunRepository,
    private readonly peakHoursRepository: PeakHoursRepository,
    private readonly peakSchedule: PeakSchedule,
    private readonly clock: Clock,
    private readonly timer: SchedulerTimer = SYSTEM_TIMER,
  ) {}

  public async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;
    const current = await this.peakHoursRepository.get();
    if (current === null || !this.peakSchedule.isPeakAt(current, this.clock.now())) {
      await this.drainAll();
    }
    if (current !== null) {
      this.armBoundary(current);
    }
  }

  public async close(): Promise<void> {
    this.started = false;
    this.cancelTimer();
  }

  public eventCreated(): void {}

  public runCreated(): void {}

  public runStateChanged(): void {}

  public pausedChanged(): void {}

  public async peakHoursChanged(peakHours: PeakHours | null): Promise<void> {
    if (!this.started) {
      return;
    }
    this.cancelTimer();
    if (peakHours === null || !this.peakSchedule.isPeakAt(peakHours, this.clock.now())) {
      await this.drainAll();
    }
    if (peakHours !== null) {
      this.armBoundary(peakHours);
    }
  }

  private armBoundary(peakHours: PeakHours): void {
    const boundary = this.peakSchedule.nextOffPeakBoundary(peakHours, this.clock.now());
    if (boundary === null) {
      return;
    }
    const delay = Math.max(0, boundary.getTime() - this.clock.now().getTime());
    this.timerHandle = this.timer.setTimeout(() => {
      void this.onBoundary();
    }, delay);
  }

  private async onBoundary(): Promise<void> {
    this.timerHandle = null;
    await this.drainAll();
    const current = await this.peakHoursRepository.get();
    if (current !== null) {
      this.armBoundary(current);
    }
  }

  private async drainAll(): Promise<void> {
    const result = await this.runRepository.listByState("WAIT_FOR_OFFPEAK", {
      limit: DEFAULT_LIST_LIMIT,
      offset: 0,
    });
    for (const parked of result.items) {
      await this.dispatcher.resume(parked.id);
    }
  }

  private cancelTimer(): void {
    if (this.timerHandle !== null) {
      this.timer.clearTimeout(this.timerHandle);
      this.timerHandle = null;
    }
  }
}
