import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import ConsumerConfigPanel from "./consumer-config-panel.vue";
import type { ConsumerDto } from "../infra/types";

function makeConsumer(overrides: Partial<ConsumerDto> = {}): ConsumerDto {
  return {
    id: "agent-consumer-a",
    enabled: true,
    waitForOffPeak: false,
    configParameters: [],
    configValues: {},
    secretParameters: [],
    secretNames: [],
    ...overrides,
  };
}

function findButtonByText(wrapper: ReturnType<typeof mount>, text: string): ReturnType<typeof wrapper.findAll>[number] {
  const buttons = wrapper.findAll("button");
  const found = buttons.find((button) => button.text().trim() === text);
  if (found === undefined) {
    throw new Error(`button with text "${text}" not found; buttons were: ${buttons.map((b) => b.text()).join(" | ")}`);
  }
  return found;
}

describe("consumer-config-panel.vue", () => {
  it("renders one row per declared secretParameter with an empty value input", () => {
    const wrapper = mount(ConsumerConfigPanel, {
      props: {
        consumer: makeConsumer({
          secretParameters: [{ key: "githubToken", label: "GitHub token" }],
          secretNames: [],
        }),
      },
    });

    const valueInputs = wrapper.findAll('input[type="password"]');
    expect(valueInputs).toHaveLength(1);
    expect(valueInputs.every((input) => (input.element as HTMLInputElement).value === "")).toBe(true);
  });

  it("emits an upsert on saveSecrets when a secret value is typed", async () => {
    const wrapper = mount(ConsumerConfigPanel, {
      props: {
        consumer: makeConsumer({
          secretParameters: [{ key: "githubToken", label: "GitHub token" }],
          secretNames: [],
        }),
      },
    });

    const valueInput = wrapper.findAll('input[type="password"]')[0];
    await valueInput.setValue("tok-123");

    await findButtonByText(wrapper, "Save").trigger("click");

    const saveSecretsEvent = wrapper.emitted("saveSecrets");
    expect(saveSecretsEvent).toBeDefined();
    expect(saveSecretsEvent![0]).toEqual([
      { upserts: [{ name: "githubToken", value: "tok-123" }], deletes: [] },
    ]);
  });

  it("emits a delete on saveSecrets when an existing secret is cleared", async () => {
    const wrapper = mount(ConsumerConfigPanel, {
      props: {
        consumer: makeConsumer({
          secretParameters: [{ key: "githubToken", label: "GitHub token" }],
          secretNames: ["githubToken"],
        }),
      },
    });

    await findButtonByText(wrapper, "Clear").trigger("click");

    await findButtonByText(wrapper, "Save").trigger("click");

    const saveSecretsEvent = wrapper.emitted("saveSecrets");
    expect(saveSecretsEvent).toBeDefined();
    expect(saveSecretsEvent![0]).toEqual([
      { upserts: [], deletes: ["githubToken"] },
    ]);
  });

  it("emits no operation for a secret left empty and not cleared", async () => {
    const wrapper = mount(ConsumerConfigPanel, {
      props: {
        consumer: makeConsumer({
          secretParameters: [{ key: "githubToken", label: "GitHub token" }],
          secretNames: ["githubToken"],
        }),
      },
    });

    await findButtonByText(wrapper, "Save").trigger("click");

    const saveSecretsEvent = wrapper.emitted("saveSecrets");
    expect(saveSecretsEvent).toBeDefined();
    expect(saveSecretsEvent![0]).toEqual([
      { upserts: [], deletes: [] },
    ]);
  });

  it("emits both the visible-values save and the assembled saveSecrets on save", async () => {
    const wrapper = mount(ConsumerConfigPanel, {
      props: {
        consumer: makeConsumer({
          configParameters: [{ key: "modelId", label: "Model", required: true, defaultValue: "" }],
          configValues: { modelId: "old" },
          secretParameters: [{ key: "githubToken", label: "GitHub token" }],
          secretNames: [],
        }),
      },
    });

    const textInput = wrapper.find('input[type="text"]');
    await textInput.setValue("new-model");

    const secretInput = wrapper.findAll('input[type="password"]')[0];
    await secretInput.setValue("tok-1");

    await findButtonByText(wrapper, "Save").trigger("click");

    const saveEvent = wrapper.emitted("save");
    expect(saveEvent).toBeDefined();
    expect(saveEvent![0]).toEqual([{ modelId: "new-model" }]);

    const saveSecretsEvent = wrapper.emitted("saveSecrets");
    expect(saveSecretsEvent).toBeDefined();
    expect(saveSecretsEvent![0]).toEqual([
      { upserts: [{ name: "githubToken", value: "tok-1" }], deletes: [] },
    ]);
  });
});
