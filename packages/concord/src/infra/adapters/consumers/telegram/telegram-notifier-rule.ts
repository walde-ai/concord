import type { Rule } from "../../../../domain/ports/out/rule";
import type { Event } from "../../../../domain/entities/event";
import { RUN_INPUT_REQUESTED } from "../../../../domain/events/run-input-event";

export class TelegramNotifierRule implements Rule<unknown> {
  public decide(event: Event<unknown>): boolean {
    return event.type === RUN_INPUT_REQUESTED;
  }
}
