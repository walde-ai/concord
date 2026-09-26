import type { FieldOption } from "../../event-template";
import type { AnswerMap } from "../../entities/run-form";

export interface ResolveEventTemplateFieldOptions {
  resolve(templateId: string, fieldKey: string, answers: AnswerMap): Promise<readonly FieldOption[]>;
}
