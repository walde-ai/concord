import type { EventTemplate } from "../../../domain/ports/in/event-template";
import type { Registration } from "../../../domain/ports/in/registration";
import type { EventTemplateDescriptor, EventTemplateEmission, FieldOption } from "../../../domain/event-template";
import type { AnswerMap } from "../../../domain/entities/run-form";
import type { ContextResolver } from "../../../domain/ports/out/context-resolver";
import { InvalidEventTemplateAnswersError } from "../../../domain/exceptions/errors";
import { RAWJSON } from "../producers/websocket/websocket-producer";
import { extractRawJsonProducerEventId } from "../producers/websocket/raw-json-event-id";

const RAW_JSON_TEMPLATE_ID = "raw-json";
const RAW_JSON_PRODUCER_ID = "web-ui";
const RAW_JSON_FIELD_KEY = "json";
const RAW_JSON_LABEL = "Raw JSON";
const RAW_JSON_PLACEHOLDER = `{
  "eventId": "my-event-1",
  "data": {}
}`;
const RAW_JSON_DESCRIPTION =
  "Submit a raw JSON object as the entire event payload. A top-level `eventId` string field is required and acts as the idempotency key. The parsed object becomes the event payload and the event type is `rawjson`.";

export class RawJsonEventTemplate implements EventTemplate {
  public readonly descriptor: EventTemplateDescriptor = {
    id: RAW_JSON_TEMPLATE_ID,
    label: RAW_JSON_LABEL,
    description: RAW_JSON_DESCRIPTION,
    producerId: RAW_JSON_PRODUCER_ID,
    fields: [
      {
        key: RAW_JSON_FIELD_KEY,
        label: "JSON",
        inputType: "textarea",
        defaultValue: "",
        placeholder: RAW_JSON_PLACEHOLDER,
      },
    ],
  };

  public readonly id: string = RAW_JSON_TEMPLATE_ID;
  public readonly producerId: string = RAW_JSON_PRODUCER_ID;

  public register(registration: Registration): void {
    registration.addEventTemplate(this);
  }

  public resolveDescriptor(_contexts: ContextResolver): Promise<EventTemplateDescriptor> {
    return Promise.resolve(this.descriptor);
  }

  public resolveFieldOptions(_fieldKey: string, _answers: AnswerMap, _contexts: ContextResolver): Promise<readonly FieldOption[]> {
    return Promise.resolve([]);
  }

  public build(answers: AnswerMap): EventTemplateEmission {
    const raw = answers[RAW_JSON_FIELD_KEY];
    if (typeof raw !== "string") {
      throw new InvalidEventTemplateAnswersError(`Field "${RAW_JSON_FIELD_KEY}" must be a string`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new InvalidEventTemplateAnswersError(`Field "${RAW_JSON_FIELD_KEY}" is not valid JSON: ${message}`);
    }
    const producerEventId = extractRawJsonProducerEventId(parsed);
    if (producerEventId === null) {
      throw new InvalidEventTemplateAnswersError(
        `Field "${RAW_JSON_FIELD_KEY}" must contain a non-empty string \`eventId\` field`,
      );
    }
    return {
      type: RAWJSON,
      payload: parsed,
      producerEventId,
    };
  }
}
