import type { EventTemplate } from "../in/event-template";

export interface EventTemplateRegistry {
  all(): readonly EventTemplate[];
  getById(id: string): EventTemplate | null;
}
