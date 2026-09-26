import type { RunUpdate } from "../../entities/run-update";

export interface RecordRunUpdate {
  record(runId: string, message: string): Promise<RunUpdate>;
}
