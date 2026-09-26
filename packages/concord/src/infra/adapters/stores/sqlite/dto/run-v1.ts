import { Run, RunFailure, type RunState } from "../../../../../domain/entities/run";
import type { Event } from "../../../../../domain/entities/event";

interface RunFailureDto {
  readonly errorName: string;
  readonly message: string;
  readonly stack: string | null;
}

export class RunV1 {
  public static readonly version = "v1";

  public constructor(
    public readonly id: string,
    public readonly eventId: string,
    public readonly consumerId: string,
    public readonly state: RunState,
    public readonly failure: RunFailure | null,
    public readonly startedAt: string | null = null,
    public readonly finishedAt: string | null = null,
  ) {}

  public toDomain(event: Event<unknown>): Run<unknown> {
    return new Run<unknown>(
      this.id,
      event,
      this.consumerId,
      this.state,
      this.failure,
      this.startedAt === null ? null : new Date(this.startedAt),
      this.finishedAt === null ? null : new Date(this.finishedAt),
    );
  }

  public static fromDomain(run: Run<unknown>): RunV1 {
    return new RunV1(
      run.id,
      run.event.id,
      run.consumerId,
      run.state,
      run.failure,
      run.startedAt === null ? null : run.startedAt.toISOString(),
      run.finishedAt === null ? null : run.finishedAt.toISOString(),
    );
  }
}

export function serializeRunFailure(failure: RunFailure | null): string | null {
  if (failure === null) {
    return null;
  }
  const dto: RunFailureDto = {
    errorName: failure.errorName,
    message: failure.message,
    stack: failure.stack,
  };
  return JSON.stringify(dto);
}

export function deserializeRunFailure(serialized: string | null): RunFailure | null {
  if (serialized === null) {
    return null;
  }
  const parsed = JSON.parse(serialized) as RunFailureDto;
  return new RunFailure(parsed.errorName, parsed.message, parsed.stack);
}
