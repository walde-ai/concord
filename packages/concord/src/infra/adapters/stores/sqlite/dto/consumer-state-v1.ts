export class ConsumerStateV1 {
  public static readonly version = "v1";

  public constructor(
    public readonly id: string,
    public readonly enabled: boolean,
    public readonly waitForOffPeak: boolean,
  ) {}

  public toRow(): { enabled: number; waitForOffPeak: number } {
    return { enabled: this.enabled ? 1 : 0, waitForOffPeak: this.waitForOffPeak ? 1 : 0 };
  }

  public static fromRow(id: string, enabled: number, waitForOffPeak: number): ConsumerStateV1 {
    return new ConsumerStateV1(id, enabled === 1, waitForOffPeak === 1);
  }
}
