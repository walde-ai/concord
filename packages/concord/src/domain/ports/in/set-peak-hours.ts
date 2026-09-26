import type { PeakHours } from "../../peak-hours";

export interface SetPeakHours {
  set(value: PeakHours | null): Promise<PeakHours | null>;
}
