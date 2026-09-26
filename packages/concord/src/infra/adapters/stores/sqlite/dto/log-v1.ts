import type { LogEntry } from "../../../../../domain/ports/out/logger";

export class LogV1 {
  public static readonly version = "2026-07-11";

  public constructor(
    public readonly timestamp: string,
    public readonly level: string,
    public readonly source: string,
    public readonly message: string,
    public readonly fieldsJson: string | null,
  ) {}

  public toDomain(): LogEntry {
    const entry: LogEntry = this.fieldsJson !== null
      ? {
          timestamp: this.timestamp,
          level: this.level as LogEntry["level"],
          source: this.source,
          message: this.message,
          fields: JSON.parse(this.fieldsJson) as Record<string, unknown>,
        }
      : {
          timestamp: this.timestamp,
          level: this.level as LogEntry["level"],
          source: this.source,
          message: this.message,
        };
    return entry;
  }

  public static fromDomain(entry: LogEntry): LogV1 {
    return new LogV1(
      entry.timestamp,
      entry.level,
      entry.source,
      entry.message,
      entry.fields === undefined ? null : JSON.stringify(entry.fields),
    );
  }
}
