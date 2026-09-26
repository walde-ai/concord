import type { PauseStateRepository } from "../../../domain/ports/out/pause-state-repository";

export class InMemoryPauseStateRepository implements PauseStateRepository {
  private paused = false;

  public async isPaused(): Promise<boolean> {
    return this.paused;
  }

  public async setPaused(paused: boolean): Promise<void> {
    this.paused = paused;
  }
}
