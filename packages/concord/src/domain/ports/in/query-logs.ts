import type { LogStoreQuery, LogStoreResult } from "../out/log-store";

export interface QueryLogs {
  query(query: LogStoreQuery): Promise<LogStoreResult>;
}
