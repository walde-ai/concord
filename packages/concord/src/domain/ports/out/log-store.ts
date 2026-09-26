import type { LogLevel, LogEntry } from "./logger";

export interface LogStoreQuery {
  readonly limit: number;
  readonly offset: number;
  readonly level?: LogLevel;
  readonly source?: string;
  readonly text?: string;
  readonly startTime?: string;
  readonly endTime?: string;
  readonly eventId?: string;
  readonly runId?: string;
  readonly consumerId?: string;
}

export interface LogStoreResult {
  readonly items: LogEntry[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export interface LogStore {
  append(entry: LogEntry): Promise<void>;
  query(query: LogStoreQuery): Promise<LogStoreResult>;
  distinctSources(): Promise<string[]>;
}
