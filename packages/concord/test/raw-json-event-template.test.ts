import { describe, it, expect } from "vitest";
import { RawJsonEventTemplate } from "../src/infra/adapters/event-templates/raw-json-event-template";
import { InvalidEventTemplateAnswersError } from "../src/domain/exceptions/errors";
import { RAWJSON } from "../src/infra/adapters/producers/websocket/websocket-producer";

describe("RawJsonEventTemplate", () => {
  it("exposes a descriptor with the raw-json id, web-ui producerId, and a single textarea field keyed json", () => {
    const template = new RawJsonEventTemplate();
    expect(template.id).toBe("raw-json");
    expect(template.producerId).toBe("web-ui");
    expect(template.descriptor.id).toBe("raw-json");
    expect(template.descriptor.producerId).toBe("web-ui");
    expect(template.descriptor.fields).toHaveLength(1);
    const field = template.descriptor.fields[0];
    expect(field.key).toBe("json");
    expect(field.inputType).toBe("textarea");
    expect(field.placeholder).toBe(`{
  "eventId": "my-event-1",
  "data": {}
}`);
  });

  it("builds an emission of type rawjson with the parsed payload and extracted eventId", () => {
    const template = new RawJsonEventTemplate();
    const emission = template.build({
      json: JSON.stringify({ eventId: "pevt-1", hello: "world" }),
    });
    expect(emission.type).toBe(RAWJSON);
    expect(emission.producerEventId).toBe("pevt-1");
    expect(emission.payload).toEqual({ eventId: "pevt-1", hello: "world" });
  });

  it("throws InvalidEventTemplateAnswersError on unparseable JSON", () => {
    const template = new RawJsonEventTemplate();
    expect(() => template.build({ json: "this is not json" })).toThrow(
      InvalidEventTemplateAnswersError,
    );
  });

  it("throws InvalidEventTemplateAnswersError when the parsed object has no string eventId", () => {
    const template = new RawJsonEventTemplate();
    expect(() => template.build({ json: JSON.stringify({ hello: "world" }) })).toThrow(
      InvalidEventTemplateAnswersError,
    );
    expect(() => template.build({ json: JSON.stringify({ eventId: 123 }) })).toThrow(
      InvalidEventTemplateAnswersError,
    );
  });
});
