import type { SetPauseState } from "../ports/in/set-pause-state";
import type { PauseStateRepository } from "../ports/out/pause-state-repository";
import type { EventLifecycleObserver } from "../ports/out/event-lifecycle-observer";

export class SetPauseStateInteractor implements SetPauseState {
  public constructor(
    private readonly repository: PauseStateRepository,
    private readonly observer: EventLifecycleObserver,
  ) {}

  public async setPaused(paused: boolean): Promise<void> {
    await this.repository.setPaused(paused);
    this.observer.pausedChanged(paused);
  }
}
