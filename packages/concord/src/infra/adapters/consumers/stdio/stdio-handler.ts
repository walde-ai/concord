import type { Handler } from "../../../../domain/ports/out/handler";
import type { Run } from "../../../../domain/entities/run";
import type { Result } from "../../../../domain/result";
import { success } from "../../../../domain/result";
import type { EventHandlerError } from "../../../../domain/exceptions/errors";

export class StdioHandler implements Handler<unknown> {
  public async handle(run: Run<unknown>, _signal: AbortSignal): Promise<Result<void, EventHandlerError>> {
    const event = run.event;
    const line = JSON.stringify({
      id: event.id,
      producerId: event.producerId,
      datetime: event.datetime.toISOString(),
      type: event.type,
      payload: event.payload,
    });
    process.stdout.write(line + "\n");
    return success(undefined);
  }
}
