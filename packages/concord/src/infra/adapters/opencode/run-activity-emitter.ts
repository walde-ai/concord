export interface RunActivityFrame {
  readonly runId: string;
  readonly consumerId: string;
  readonly sessionId: string;
  readonly kind: string;
  readonly payload: Record<string, unknown>;
  readonly at: string;
}

export interface RunActivityEmitter {
  emit(frame: RunActivityFrame): void;
  hasSubscribers(): boolean;
}

export class NoOpRunActivityEmitter implements RunActivityEmitter {
  public emit(_frame: RunActivityFrame): void {}

  public hasSubscribers(): boolean {
    return false;
  }
}
