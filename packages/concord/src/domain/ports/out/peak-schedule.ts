import type { PeakHours } from "../../peak-hours";

export interface PeakSchedule {
  isPeakAt(peakHours: PeakHours | null, now: Date): boolean;
  nextOffPeakBoundary(peakHours: PeakHours | null, now: Date): Date | null;
}
