import type { GetPauseState } from "../ports/in/get-pause-state";
import type { PauseStateRepository } from "../ports/out/pause-state-repository";

export class GetPauseStateInteractor implements GetPauseState {
  public constructor(private readonly repository: PauseStateRepository) {}

  public async isPaused(): Promise<boolean> {
    return this.repository.isPaused();
  }
}
