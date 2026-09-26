import type { Clock } from "../../../domain/ports/out/clock";

export class SystemClock implements Clock {
  public now(): Date {
    return new Date();
  }
}
