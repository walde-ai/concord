import type { LogStoreQuery, LogStoreResult } from "../../domain/ports/out/log-store";
import type { LocalDeps } from "../main/local-compose";
import { closeLocalDeps } from "../main/local-compose";

export interface LogsQueryInput {
  readonly deps: LocalDeps;
  readonly query: LogStoreQuery;
}

export async function logsQueryCommand(input: LogsQueryInput): Promise<LogStoreResult> {
  const result = await input.deps.bundle.logStore.query(input.query);
  await closeLocalDeps(input.deps);
  return result;
}
