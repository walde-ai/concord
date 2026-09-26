import type { RunUpdate } from "../../entities/run-update";

export interface RunUpdateRepository {
  save(update: RunUpdate): Promise<void>;
  listByRun(runId: string): Promise<RunUpdate[]>;
}
