import type { EmitEventTemplate } from "../ports/in/emit-event-template";
import type { EventSink } from "../ports/in/event-sink";
import type { EventTemplateRegistry } from "../ports/out/event-template-registry";
import type { IdGenerator } from "../ports/out/id-generator";
import type { Clock } from "../ports/out/clock";
import type { ContextResolver } from "../ports/out/context-resolver";
import type { AnswerMap } from "../entities/run-form";
import type { EventDescriptor } from "../event-descriptor";
import { Event } from "../entities/event";
import {
  EventTemplateNotFoundError,
  InvalidEventTemplateAnswersError,
  InvalidFormAnswersError,
} from "../exceptions/errors";
import { validateAnswers } from "./answer-validator";

export class EmitEventTemplateInteractor implements EmitEventTemplate {
  public constructor(
    private readonly registry: EventTemplateRegistry,
    private readonly sink: EventSink,
    private readonly idGenerator: IdGenerator,
    private readonly clock: Clock,
    private readonly contexts: ContextResolver,
  ) {}

  public async emit(templateId: string, answers: AnswerMap): Promise<EventDescriptor> {
    const template = this.registry.getById(templateId);
    if (template === null) {
      throw new EventTemplateNotFoundError(templateId);
    }
    const descriptor = await template.resolveDescriptor(this.contexts);
    try {
      validateAnswers(descriptor.fields, answers);
    } catch (cause) {
      if (cause instanceof InvalidFormAnswersError) {
        throw new InvalidEventTemplateAnswersError(cause.message);
      }
      throw cause;
    }
    const emission = template.build(answers);
    const id = this.idGenerator.generate();
    const datetime = this.clock.now();
    const event = new Event<unknown>(
      id,
      template.producerId,
      emission.producerEventId,
      datetime,
      emission.type,
      emission.payload,
    );
    await this.sink.emit(event);
    return {
      id,
      producerId: template.producerId,
      producerEventId: emission.producerEventId,
      datetime,
      type: emission.type,
      payload: emission.payload,
    };
  }
}
