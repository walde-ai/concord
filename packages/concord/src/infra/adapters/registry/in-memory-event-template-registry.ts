import type { EventTemplateRegistry } from "../../../domain/ports/out/event-template-registry";
import type { EventTemplate } from "../../../domain/ports/in/event-template";

export class InMemoryEventTemplateRegistry implements EventTemplateRegistry {
  private readonly templates: Map<string, EventTemplate> = new Map();
  private readonly order: string[] = [];

  public register(template: EventTemplate): void {
    if (!this.templates.has(template.id)) {
      this.order.push(template.id);
    }
    this.templates.set(template.id, template);
  }

  public all(): readonly EventTemplate[] {
    return this.order.map((id) => this.templates.get(id) as EventTemplate);
  }

  public getById(id: string): EventTemplate | null {
    return this.templates.get(id) ?? null;
  }
}
