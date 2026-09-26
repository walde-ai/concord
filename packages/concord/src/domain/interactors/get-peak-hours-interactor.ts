import type { GetPeakHours } from "../ports/in/get-peak-hours";
import type { PeakHours } from "../peak-hours";
import type { PeakHoursRepository } from "../ports/out/peak-hours-repository";

export class GetPeakHoursInteractor implements GetPeakHours {
  public constructor(private readonly repository: PeakHoursRepository) {}

  public async get(): Promise<PeakHours | null> {
    return this.repository.get();
  }
}
