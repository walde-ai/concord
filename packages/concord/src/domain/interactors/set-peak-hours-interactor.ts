import type { SetPeakHours } from "../ports/in/set-peak-hours";
import type { PeakHours } from "../peak-hours";
import type { PeakHoursRepository } from "../ports/out/peak-hours-repository";
import type { EventLifecycleObserver } from "../ports/out/event-lifecycle-observer";

export class SetPeakHoursInteractor implements SetPeakHours {
  public constructor(
    private readonly repository: PeakHoursRepository,
    private readonly observer: EventLifecycleObserver,
  ) {}

  public async set(value: PeakHours | null): Promise<PeakHours | null> {
    await this.repository.set(value);
    this.observer.peakHoursChanged(value);
    return value;
  }
}
