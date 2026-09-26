export class Event<T> {
  public muted: boolean;

  public constructor(
    public readonly id: string,
    public readonly producerId: string,
    public readonly producerEventId: string,
    public readonly datetime: Date,
    public readonly type: string,
    public readonly payload: T,
  ) {
    this.muted = false;
  }

  public markMuted(): void {
    this.muted = true;
  }
}
