export interface PauseStateRepository {
  isPaused(): Promise<boolean>;
  setPaused(paused: boolean): Promise<void>;
}
