import type { PeakHours } from "../../peak-hours";

export interface PeakHoursRepository {
  get(): Promise<PeakHours | null>;
  set(value: PeakHours | null): Promise<void>;
}
