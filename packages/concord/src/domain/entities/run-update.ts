export class RunUpdate {
  public constructor(
    public readonly id: string,
    public readonly runId: string,
    public readonly consumerId: string,
    public readonly message: string,
    public readonly createdAt: Date,
  ) {}
}
