import type { Registrable } from "./registrable";
import type { EventTemplateDescriptor, EventTemplateEmission, FieldOption } from "../../event-template";
import type { AnswerMap } from "../../entities/run-form";
import type { ContextResolver } from "../out/context-resolver";

export interface EventTemplate extends Registrable {
  readonly id: string;
  readonly producerId: string;
  readonly descriptor: EventTemplateDescriptor;
  resolveDescriptor(contexts: ContextResolver): Promise<EventTemplateDescriptor>;
  resolveFieldOptions(fieldKey: string, answers: AnswerMap, contexts: ContextResolver): Promise<readonly FieldOption[]>;
  build(answers: AnswerMap): EventTemplateEmission;
}
