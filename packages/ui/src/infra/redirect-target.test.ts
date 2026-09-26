import { describe, expect, it } from "vitest";
import { safeRedirectTarget } from "./redirect-target";

describe("safeRedirectTarget", () => {
  it("accepts same-app paths", () => {
    expect(safeRedirectTarget("/events")).toBe("/events");
    expect(safeRedirectTarget("/runs/689b539a-7fca-4c7e-a8bb-158566bcc53a")).toBe(
      "/runs/689b539a-7fca-4c7e-a8bb-158566bcc53a",
    );
    expect(safeRedirectTarget("/logs?level=warn")).toBe("/logs?level=warn");
  });

  it("rejects non-string and empty values", () => {
    expect(safeRedirectTarget(undefined)).toBeNull();
    expect(safeRedirectTarget(null)).toBeNull();
    expect(safeRedirectTarget(123)).toBeNull();
    expect(safeRedirectTarget("")).toBeNull();
  });

  it("rejects absolute and protocol-relative URLs", () => {
    expect(safeRedirectTarget("https://evil.example/runs")).toBeNull();
    expect(safeRedirectTarget("//evil.example")).toBeNull();
    expect(safeRedirectTarget("events")).toBeNull();
  });

  it("rejects backslash tricks", () => {
    expect(safeRedirectTarget("/\\evil.example")).toBeNull();
    expect(safeRedirectTarget("/runs\\..\\..\\events")).toBeNull();
  });
});
