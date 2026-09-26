export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  readonly timestamp: string;
  readonly level: LogLevel;
  readonly source: string;
  readonly message: string;
  readonly fields?: Readonly<Record<string, unknown>>;
}

export interface Logger {
  log(entry: LogEntry): void;
  debug(source: string, message: string, fields?: Readonly<Record<string, unknown>>): void;
  info(source: string, message: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(source: string, message: string, fields?: Readonly<Record<string, unknown>>): void;
  error(source: string, message: string, fields?: Readonly<Record<string, unknown>>): void;
}

export const noopLogger: Logger = {
  log: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
