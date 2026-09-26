import type { Run } from "../../entities/run";
import type { Result } from "../../result";
import type { EventHandlerError } from "../../exceptions/errors";

export interface Handler<T> {
  handle(run: Run<T>, signal: AbortSignal): Promise<Result<void, EventHandlerError>>;
}
