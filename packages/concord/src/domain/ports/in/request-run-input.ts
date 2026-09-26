import type { AnswerMap, FormDefinition } from "../../entities/run-form";

export interface RequestRunInput {
  request(runId: string, definition: FormDefinition): Promise<AnswerMap>;
}
