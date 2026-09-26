import type { Run } from "../../entities/run";

export interface RestartRun {
  restart(runId: string): Promise<Run<unknown>>;
}
