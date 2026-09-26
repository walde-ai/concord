import { RunUpdate } from "../entities/run-update";
import type { RecordRunUpdate } from "../ports/in/record-run-update";
import type { RunUpdateRepository } from "../ports/out/run-update-repository";
import type { RunRepository } from "../ports/out/run-repository";
import type { IdGenerator } from "../ports/out/id-generator";
import type { Clock } from "../ports/out/clock";

// 8 KiB byte cap on the persisted markdown body, enforced before the update is
// created. Keeps a pathological model message from dominating a row or the
// Activity feed; surfaced to the model as a tool error so it can shorten and
// retry.
export const MAX_RUN_UPDATE_MESSAGE_BYTES = 8 * 1024;

export class RecordRunUpdateInteractor implements RecordRunUpdate {
  public constructor(
    private readonly runUpdateRepository: RunUpdateRepository,
    private readonly runRepository: RunRepository,
    private readonly idGenerator: IdGenerator,
    private readonly clock: Clock,
  ) {}

  public async record(runId: string, message: string): Promise<RunUpdate> {
    validateMessage(message);

    const run = await this.runRepository.getById(runId);
    const now = this.clock.now();
    const update = new RunUpdate(
      this.idGenerator.generate(),
      runId,
      run.consumerId,
      message,
      now,
    );
    await this.runUpdateRepository.save(update);
    return update;
  }
}

export class InvalidRunUpdateMessageError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "InvalidRunUpdateMessageError";
  }
}

function validateMessage(message: string): void {
  if (typeof message !== "string" || message.length === 0) {
    throw new InvalidRunUpdateMessageError("Run update message must be a non-empty string");
  }
  const byteLength = Buffer.byteLength(message, "utf8");
  if (byteLength > MAX_RUN_UPDATE_MESSAGE_BYTES) {
    throw new InvalidRunUpdateMessageError(
      `Run update message exceeds the ${MAX_RUN_UPDATE_MESSAGE_BYTES}-byte limit (${byteLength} bytes)`,
    );
  }
}
