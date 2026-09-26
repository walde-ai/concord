import type { Rule } from "../../../../domain/ports/out/rule";
import type { Event } from "../../../../domain/entities/event";

export class StdioRule implements Rule<unknown> {
  public decide(_event: Event<unknown>): boolean {
    return true;
  }
}
