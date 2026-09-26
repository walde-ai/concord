import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import PayloadViewer from "./payload-viewer.vue";

describe("payload-viewer.vue", () => {
  it("renders JSON without URLs as plain text with no anchors", () => {
    const wrapper = mount(PayloadViewer, {
      props: { payload: { name: "test", value: 42 } },
    });

    const text = wrapper.find("pre").text();
    expect(text).toContain('"name": "test"');
    expect(text).toContain('"value": 42');
    expect(wrapper.findAll("a")).toHaveLength(0);
  });

  it("linkifies URLs in nested and top-level JSON string values", () => {
    const payload = {
      repo: {
        owner: "example-corp",
        repo: "app",
        url: "https://github.com/example-corp/app",
      },
      number: 850,
      url: "https://github.com/example-corp/app/pull/850",
    };

    const wrapper = mount(PayloadViewer, { props: { payload } });

    const links = wrapper.findAll("a");
    expect(links).toHaveLength(2);
    expect(links[0].attributes("href")).toBe("https://github.com/example-corp/app");
    expect(links[1].attributes("href")).toBe("https://github.com/example-corp/app/pull/850");
  });

  it("opens links in a new tab with noopener rel", () => {
    const wrapper = mount(PayloadViewer, {
      props: { payload: { url: "https://example.com" } },
    });

    const link = wrapper.find("a");
    expect(link.attributes("target")).toBe("_blank");
    expect(link.attributes("rel")).toBe("noopener noreferrer");
  });

  it("applies cursor-pointer and hover:underline classes to links", () => {
    const wrapper = mount(PayloadViewer, {
      props: { payload: { url: "https://example.com" } },
    });

    const classes = wrapper.find("a").classes();
    expect(classes).toContain("cursor-pointer");
    expect(classes).toContain("hover:underline");
  });

  it("preserves the full JSON text including surrounding non-URL content", () => {
    const wrapper = mount(PayloadViewer, {
      props: { payload: { name: "test", url: "https://example.com" } },
    });

    const text = wrapper.find("pre").text();
    expect(text).toContain('"name": "test"');
    expect(text).toContain('"url":');
    expect(text).toContain("https://example.com");
  });

  it("linkifies URLs embedded inside longer markdown-style message strings", () => {
    const wrapper = mount(PayloadViewer, {
      props: {
        payload: { message: "See https://example.com/docs for details and also https://other.com" },
      },
    });

    const links = wrapper.findAll("a");
    expect(links).toHaveLength(2);
    expect(links[0].attributes("href")).toBe("https://example.com/docs");
    expect(links[1].attributes("href")).toBe("https://other.com");
  });

  it("does not linkify plain text paths or domains without a protocol", () => {
    const wrapper = mount(PayloadViewer, {
      props: {
        payload: {
          path: "packages/cdk/bin/writer.ts",
          host: "hub.alpha.walde.ai",
          sha: "1e6272ef1ef86598f17859bb677d9c3397db2b57",
        },
      },
    });

    expect(wrapper.findAll("a")).toHaveLength(0);
  });

  it("renders the full JSON without introducing extra whitespace", () => {
    const payload = { a: 1, url: "https://example.com", b: 2 };
    const expectedJson = JSON.stringify(payload, null, 2);
    const wrapper = mount(PayloadViewer, { props: { payload } });

    expect(wrapper.find("pre").text()).toBe(expectedJson);
  });
});
