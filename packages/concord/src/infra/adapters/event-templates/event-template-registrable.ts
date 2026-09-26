import type { Registrable } from "../../../domain/ports/in/registrable";
import type { Registration } from "../../../domain/ports/in/registration";
import type { EventTemplate } from "../../../domain/ports/in/event-template";

export class EventTemplateRegistrable implements Registrable {
  public constructor(private readonly template: EventTemplate) {}

  public register(registration: Registration): void {
    registration.addEventTemplate(this.template);
  }
}
