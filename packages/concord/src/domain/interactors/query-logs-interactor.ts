import type { QueryLogs } from "../ports/in/query-logs";
import type { LogStore, LogStoreQuery, LogStoreResult } from "../ports/out/log-store";

export class QueryLogsInteractor implements QueryLogs {
  public constructor(
    private readonly store: LogStore,
  ) {}

  public async query(query: LogStoreQuery): Promise<LogStoreResult> {
    return this.store.query(query);
  }
}
