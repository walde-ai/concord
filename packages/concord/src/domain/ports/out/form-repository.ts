import type { RunForm } from "../../entities/run-form";

export interface FormRepository {
  save(form: RunForm): Promise<void>;
  getById(id: string): Promise<RunForm>;
  listByRun(runId: string): Promise<RunForm[]>;
  countByRun(runId: string): Promise<number>;
  getPendingByRun(runId: string): Promise<RunForm | null>;
}
