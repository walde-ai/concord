import type { AnswerMap, RunForm } from "../../entities/run-form";

export interface SubmitRunInput {
  submit(runId: string, formId: string, answers: AnswerMap): Promise<RunForm>;
}
