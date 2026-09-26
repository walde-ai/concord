import type { PeakHoursRepository } from "../../../domain/ports/out/peak-hours-repository";
import type { PeakHours } from "../../../domain/peak-hours";

export class InMemoryPeakHoursRepository implements PeakHoursRepository {
  private value: PeakHours | null = null;

  public async get(): Promise<PeakHours | null> {
    return this.value;
  }

  public async set(value: PeakHours | null): Promise<void> {
    this.value = value;
  }
}
