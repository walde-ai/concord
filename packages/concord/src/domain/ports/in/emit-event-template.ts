import type { AnswerMap } from "../../entities/run-form";
import type { EventDescriptor } from "../../event-descriptor";

export interface EmitEventTemplate {
  emit(templateId: string, answers: AnswerMap): Promise<EventDescriptor>;
}
