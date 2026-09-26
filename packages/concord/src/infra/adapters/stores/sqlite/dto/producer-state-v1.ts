export class ProducerStateV1 {
  public static readonly version = "v1";

  public constructor(
    public readonly id: string,
    public readonly enabled: boolean,
  ) {}

  public toRow(): { enabled: number } {
    return { enabled: this.enabled ? 1 : 0 };
  }

  public static fromRow(id: string, enabled: number): ProducerStateV1 {
    return new ProducerStateV1(id, enabled === 1);
  }
}
