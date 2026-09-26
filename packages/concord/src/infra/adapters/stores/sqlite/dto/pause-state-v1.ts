export class PauseStateV1 {
  public static readonly version = "v1";

  public constructor(
    public readonly id: number,
    public readonly paused: boolean,
  ) {}

  public toRow(): { paused: number } {
    return { paused: this.paused ? 1 : 0 };
  }

  public static fromRow(id: number, paused: number): PauseStateV1 {
    return new PauseStateV1(id, paused === 1);
  }
}
