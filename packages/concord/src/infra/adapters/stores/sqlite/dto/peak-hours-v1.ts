import type { PeakHours } from "../../../../../domain/peak-hours";

export class PeakHoursV1 {
  public static readonly version = "v1";

  public constructor(
    public readonly start: string,
    public readonly end: string,
    public readonly timezone: string,
  ) {}

  public toDomain(): PeakHours {
    return { start: this.start, end: this.end, timezone: this.timezone };
  }

  public static fromDomain(peakHours: PeakHours): PeakHoursV1 {
    return new PeakHoursV1(peakHours.start, peakHours.end, peakHours.timezone);
  }
}
