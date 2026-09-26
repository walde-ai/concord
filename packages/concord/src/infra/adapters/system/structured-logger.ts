import type { Clock } from "../../../domain/ports/out/clock";
import type { Logger, LogEntry, LogLevel } from "../../../domain/ports/out/logger";
import type { LogStore } from "../../../domain/ports/out/log-store";
import {
  LOG_FIELD_CONSUMER_ID,
  LOG_FIELD_EVENT_ID,
  LOG_FIELD_RUN_ID,
  type LogContextScope,
} from "../../../domain/ports/out/log-context";

export class StructuredLogger implements Logger {
  public constructor(
    private readonly clock: Clock,
    private readonly logContextScope: LogContextScope,
    private readonly store: LogStore | null = null,
  ) {}

  public log(entry: LogEntry): void {
    process.stdout.write(JSON.stringify(entry) + "\n");
    if (this.store !== null) {
      this.store.append(entry).catch(() => {});
    }
  }

  public debug(source: string, message: string, fields?: Readonly<Record<string, unknown>>): void {
    this.log(this.buildEntry("debug", source, message, fields));
  }

  public info(source: string, message: string, fields?: Readonly<Record<string, unknown>>): void {
    this.log(this.buildEntry("info", source, message, fields));
  }

  public warn(source: string, message: string, fields?: Readonly<Record<string, unknown>>): void {
    this.log(this.buildEntry("warn", source, message, fields));
  }

  public error(source: string, message: string, fields?: Readonly<Record<string, unknown>>): void {
    this.log(this.buildEntry("error", source, message, fields));
  }

  private buildEntry(
    level: LogLevel,
    source: string,
    message: string,
    fields?: Readonly<Record<string, unknown>>,
  ): LogEntry {
    const enriched = this.enrich(fields);
    const entry: LogEntry = enriched !== undefined
      ? { timestamp: this.clock.now().toISOString(), level, source, message, fields: enriched }
      : { timestamp: this.clock.now().toISOString(), level, source, message };
    return entry;
  }

  /**
   * Merges the active {@link LogContext} into the caller-supplied fields. The
   * active context is the source of truth for `eventId`/`runId`/`consumerId`, so
   * it is applied first and an explicit value passed by the call site overrides
   * it — letting narrow call sites refine (or blank out) the inherited context
   * when they genuinely need to.
   */
  private enrich(fields?: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> | undefined {
    const context = this.logContextScope.active();
    const contextFields: Record<string, unknown> = {};
    if (context.eventId !== undefined) {
      contextFields[LOG_FIELD_EVENT_ID] = context.eventId;
    }
    if (context.runId !== undefined) {
      contextFields[LOG_FIELD_RUN_ID] = context.runId;
    }
    if (context.consumerId !== undefined) {
      contextFields[LOG_FIELD_CONSUMER_ID] = context.consumerId;
    }
    if (fields === undefined) {
      return Object.keys(contextFields).length > 0 ? contextFields : undefined;
    }
    return { ...contextFields, ...fields };
  }
}
