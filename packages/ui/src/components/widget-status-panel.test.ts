import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import WidgetStatusPanel from "./widget-status-panel.vue";
import type { StatusPanelPayload } from "../infra/types";

function availablePayload(): StatusPanelPayload {
  return {
    kind: "status-panel",
    title: "Run exec-42",
    timestamp: "2026-09-26T10:00:00.000Z",
    state: { kind: "available" },
    items: [
      { label: "Source", status: "success" },
      { label: "Build", status: "failed", link: "https://example.com/build" },
      { label: "Deploy", status: "in-progress" },
    ],
  };
}

describe("WidgetStatusPanel", () => {
  it("renders the title, the timestamp line, and a badge per item status", () => {
    const wrapper = mount(WidgetStatusPanel, {
      props: { payload: availablePayload() },
    });

    expect(wrapper.text()).toContain("Run exec-42");
    expect(wrapper.text()).toContain(new Date("2026-09-26T10:00:00.000Z").toLocaleString());

    const items = wrapper.findAll("li");
    expect(items).toHaveLength(3);
    expect(items[0].text()).toContain("Source");
    expect(items[0].find("span.bg-primary").exists()).toBe(true);
    expect(items[1].text()).toContain("Build");
    expect(items[1].find("span.bg-error").exists()).toBe(true);
    expect(items[2].text()).toContain("Deploy");
    expect(items[2].find("span.bg-blue-500").exists()).toBe(true);
  });

  it("renders an item link as an anchor", () => {
    const wrapper = mount(WidgetStatusPanel, {
      props: { payload: availablePayload() },
    });

    const link = wrapper.find("a");
    expect(link.exists()).toBe(true);
    expect(link.attributes("href")).toBe("https://example.com/build");
    expect(link.text()).toBe("Build");
  });

  it("renders the message of an errored payload instead of items", () => {
    const payload: StatusPanelPayload = {
      kind: "status-panel",
      title: "",
      state: { kind: "errored", message: "Pipeline status unavailable" },
      items: [],
    };
    const wrapper = mount(WidgetStatusPanel, { props: { payload } });

    expect(wrapper.text()).toContain("Pipeline status unavailable");
    expect(wrapper.findAll("li")).toHaveLength(0);
  });

  it("renders without a timestamp line when the payload omits it", () => {
    const payload: StatusPanelPayload = {
      kind: "status-panel",
      title: "Run exec-42",
      state: { kind: "available" },
      items: [{ label: "Source", status: "success" }],
    };
    const wrapper = mount(WidgetStatusPanel, { props: { payload } });

    expect(wrapper.text()).toContain("Run exec-42");
    expect(wrapper.text()).toContain("Source");
  });
});
