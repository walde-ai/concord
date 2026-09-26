import type { Run } from "../../entities/run";

export interface AbortRun {
  abort(runId: string): Promise<Run<unknown>>;
}
