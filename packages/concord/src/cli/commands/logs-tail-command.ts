import type { LogEntry } from "../../domain/ports/out/logger";
import type { LocalDeps } from "../main/local-compose";
import { closeLocalDeps } from "../main/local-compose";

export interface LogsTailInput {
  readonly deps: LocalDeps;
  readonly limit: number;
}

export async function logsTailCommand(input: LogsTailInput): Promise<LogEntry[]> {
  const result = await input.deps.bundle.logStore.query({
    limit: input.limit,
    offset: 0,
  });
  await closeLocalDeps(input.deps);
  const reversed = [...result.items].reverse();
  return reversed;
}
