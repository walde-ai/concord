import type { EventTemplateDescriptor } from "../../event-template";

export interface ListEventTemplates {
  list(): Promise<EventTemplateDescriptor[]>;
}
