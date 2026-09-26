import type { ResolveEventTemplateFieldOptions } from "../ports/in/resolve-event-template-field-options";
import type { EventTemplateRegistry } from "../ports/out/event-template-registry";
import type { ContextResolver } from "../ports/out/context-resolver";
import type { FieldOption } from "../event-template";
import type { AnswerMap } from "../entities/run-form";
import { EventTemplateNotFoundError } from "../exceptions/errors";

export class ResolveEventTemplateFieldOptionsInteractor implements ResolveEventTemplateFieldOptions {
  public constructor(
    private readonly registry: EventTemplateRegistry,
    private readonly contexts: ContextResolver,
  ) {}

  public async resolve(templateId: string, fieldKey: string, answers: AnswerMap): Promise<readonly FieldOption[]> {
    const template = this.registry.getById(templateId);
    if (template === null) {
      throw new EventTemplateNotFoundError(templateId);
    }
    return template.resolveFieldOptions(fieldKey, answers, this.contexts);
  }
}
