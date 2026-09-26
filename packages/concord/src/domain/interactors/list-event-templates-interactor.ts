import type { ListEventTemplates } from "../ports/in/list-event-templates";
import type { EventTemplateRegistry } from "../ports/out/event-template-registry";
import type { ContextResolver } from "../ports/out/context-resolver";
import type { EventTemplateDescriptor } from "../event-template";

export class ListEventTemplatesInteractor implements ListEventTemplates {
  public constructor(
    private readonly registry: EventTemplateRegistry,
    private readonly contexts: ContextResolver,
  ) {}

  public async list(): Promise<EventTemplateDescriptor[]> {
    const templates = this.registry.all();
    return Promise.all(templates.map((template) => template.resolveDescriptor(this.contexts)));
  }
}
