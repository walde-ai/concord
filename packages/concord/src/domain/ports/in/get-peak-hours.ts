import type { PeakHours } from "../../peak-hours";

export interface GetPeakHours {
  get(): Promise<PeakHours | null>;
}
