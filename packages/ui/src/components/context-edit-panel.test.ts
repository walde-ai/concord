import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import ContextEditPanel from "./context-edit-panel.vue";

function findButtonByText(wrapper: ReturnType<typeof mount>, text: string): ReturnType<typeof wrapper.findAll>[number] {
  const buttons = wrapper.findAll("button");
  const found = buttons.find((button) => button.text().trim() === text);
  if (found === undefined) {
    throw new Error(`button with text "${text}" not found; buttons were: ${buttons.map((b) => b.text()).join(" | ")}`);
  }
  return found;
}

describe("context-edit-panel.vue", () => {
  it("renders existing secret names from target.secretNames with empty value inputs", () => {
    const wrapper = mount(ContextEditPanel, {
      props: {
        open: true,
        target: { name: "greeting", payload: { hello: "world" }, secretNames: ["TOKEN", "OTHER"] },
      },
    });

    const nameInputs = wrapper.findAll('input[placeholder="SECRET_NAME"]');
    expect(nameInputs.map((input) => (input.element as HTMLInputElement).value)).toEqual(["TOKEN", "OTHER"]);

    const valueInputs = wrapper.findAll('input[type="password"]');
    expect(valueInputs).toHaveLength(2);
    expect(valueInputs.every((input) => (input.element as HTMLInputElement).value === "")).toBe(true);
  });

  it("emits a SecretOperation on save when an existing secret's value is filled", async () => {
    const wrapper = mount(ContextEditPanel, {
      props: {
        open: true,
        target: { name: "greeting", payload: { hello: "world" }, secretNames: ["TOKEN"] },
      },
    });

    const valueInput = wrapper.findAll('input[type="password"]')[0];
    await valueInput.setValue("new-value");

    await findButtonByText(wrapper, "Save").trigger("click");

    const updateEvent = wrapper.emitted("update");
    expect(updateEvent).toBeDefined();
    expect(updateEvent![0]).toEqual([
      "greeting",
      { hello: "world" },
      { upserts: [{ name: "TOKEN", value: "new-value" }], deletes: [] },
    ]);
  });

  it("marks an existing secret for deletion on save when the delete button is clicked", async () => {
    const wrapper = mount(ContextEditPanel, {
      props: {
        open: true,
        target: { name: "greeting", payload: { hello: "world" }, secretNames: ["TOKEN"] },
      },
    });

    await findButtonByText(wrapper, "Delete").trigger("click");
    await findButtonByText(wrapper, "Save").trigger("click");

    const updateEvent = wrapper.emitted("update");
    expect(updateEvent).toBeDefined();
    expect(updateEvent![0]).toEqual([
      "greeting",
      { hello: "world" },
      { upserts: [], deletes: ["TOKEN"] },
    ]);
  });

  it("emits a new secret as an upsert when a fresh row has both name and value filled", async () => {
    const wrapper = mount(ContextEditPanel, {
      props: {
        open: true,
        target: { name: "greeting", payload: { hello: "world" }, secretNames: [] },
      },
    });

    await findButtonByText(wrapper, "+ Add secret").trigger("click");

    await wrapper.find('input[placeholder="SECRET_NAME"]').setValue("BRAND_NEW");
    await wrapper.find('input[type="password"]').setValue("brand-value");

    await findButtonByText(wrapper, "Save").trigger("click");

    const updateEvent = wrapper.emitted("update");
    expect(updateEvent).toBeDefined();
    expect(updateEvent![0]).toEqual([
      "greeting",
      { hello: "world" },
      { upserts: [{ name: "BRAND_NEW", value: "brand-value" }], deletes: [] },
    ]);
  });

  it("emits the initial secrets array in create mode", async () => {
    const wrapper = mount(ContextEditPanel, {
      props: { open: true, target: null },
    });

    await findButtonByText(wrapper, "+ Add secret").trigger("click");
    await wrapper.find('input[placeholder="SECRET_NAME"]').setValue("TOKEN");
    await wrapper.find('input[type="password"]').setValue("abc");
    await wrapper.find('input[placeholder="my-context"]').setValue("greeting");
    await wrapper.find("textarea").setValue('{ "hello": "world" }');

    await findButtonByText(wrapper, "Save").trigger("click");

    const createEvent = wrapper.emitted("create");
    expect(createEvent).toBeDefined();
    expect(createEvent![0]).toEqual([
      "greeting",
      { hello: "world" },
      [{ name: "TOKEN", value: "abc" }],
    ]);
  });

  it("does not render the bottom delete action in create mode", () => {
    const wrapper = mount(ContextEditPanel, {
      props: { open: true, target: null },
    });

    const buttons = wrapper.findAll("button").map((button) => button.text().trim());
    expect(buttons).not.toContain("Delete context");
  });

  it("renders the bottom delete action in edit mode and emits delete", async () => {
    const wrapper = mount(ContextEditPanel, {
      props: {
        open: true,
        target: { name: "greeting", payload: { hello: "world" }, secretNames: [] },
      },
    });

    const deleteButton = findButtonByText(wrapper, "Delete context");
    expect(deleteButton.exists()).toBe(true);

    await deleteButton.trigger("click");

    const deleteEvent = wrapper.emitted("delete");
    expect(deleteEvent).toBeDefined();
    expect(deleteEvent![0]).toEqual(["greeting"]);
  });

  it("preserves an existing secret whose value is left empty and is not deleted", async () => {
    const wrapper = mount(ContextEditPanel, {
      props: {
        open: true,
        target: { name: "greeting", payload: { hello: "world" }, secretNames: ["KEEP", "REMOVE"] },
      },
    });

    const deleteButtons = wrapper.findAll("button").filter((button) => button.text().trim() === "Delete");
    expect(deleteButtons).toHaveLength(2);
    await deleteButtons[1].trigger("click");

    await findButtonByText(wrapper, "Save").trigger("click");

    const updateEvent = wrapper.emitted("update");
    expect(updateEvent).toBeDefined();
    expect(updateEvent![0]).toEqual([
      "greeting",
      { hello: "world" },
      { upserts: [], deletes: ["REMOVE"] },
    ]);
  });
});
