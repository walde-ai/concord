import { RunUpdate } from "../../../../../domain/entities/run-update";

export class RunUpdateV1 {
  public static readonly version = "v1";

  public constructor(
    public readonly id: string,
    public readonly runId: string,
    public readonly consumerId: string,
    public readonly message: string,
    public readonly createdAt: string,
  ) {}

  public toDomain(): RunUpdate {
    return new RunUpdate(
      this.id,
      this.runId,
      this.consumerId,
      this.message,
      new Date(this.createdAt),
    );
  }

  public static fromDomain(update: RunUpdate): RunUpdateV1 {
    return new RunUpdateV1(
      update.id,
      update.runId,
      update.consumerId,
      update.message,
      update.createdAt.toISOString(),
    );
  }
}
