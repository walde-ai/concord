import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { computePeakIndicator } from "./peak-indicator";
import type { PeakHoursDto } from "./types";

const originalTz = process.env.TZ;

beforeAll(() => {
  process.env.TZ = "UTC";
});

afterAll(() => {
  if (originalTz === undefined) {
    delete process.env.TZ;
  } else {
    process.env.TZ = originalTz;
  }
});

describe("computePeakIndicator", () => {
  it("returns null when peak hours are null", () => {
    expect(computePeakIndicator(null)).toBeNull();
  });

  it("returns null when start equals end", () => {
    const peak: PeakHoursDto = { start: "09:00", end: "09:00", timezone: "UTC" };
    expect(computePeakIndicator(peak)).toBeNull();
  });

  it("reports 'Peak time until' when inside the window in UTC", () => {
    const peak: PeakHoursDto = { start: "09:00", end: "17:00", timezone: "UTC" };
    const indicator = computePeakIndicator(peak, new Date("2026-07-05T10:00:00Z"));
    expect(indicator).not.toBeNull();
    expect(indicator?.peak).toBe(true);
    expect(indicator?.label).toBe("Peak time until 17:00");
  });

  it("reports 'Off peak until' the next start when outside the window in UTC", () => {
    const peak: PeakHoursDto = { start: "09:00", end: "17:00", timezone: "UTC" };
    const indicator = computePeakIndicator(peak, new Date("2026-07-05T18:00:00Z"));
    expect(indicator).not.toBeNull();
    expect(indicator?.peak).toBe(false);
    expect(indicator?.label).toBe("Off peak until 09:00");
  });

  it("reflects an edited start in the off-peak boundary label", () => {
    const peak: PeakHoursDto = { start: "08:00", end: "17:00", timezone: "UTC" };
    const indicator = computePeakIndicator(peak, new Date("2026-07-05T18:00:00Z"));
    expect(indicator?.label).toBe("Off peak until 08:00");
  });

  it("converts a non-UTC configured timezone into the device-local display", () => {
    const peak: PeakHoursDto = { start: "13:00", end: "22:00", timezone: "Asia/Manila" };
    const now = new Date("2026-07-05T06:00:00Z");
    const indicator = computePeakIndicator(peak, now);
    expect(indicator?.peak).toBe(true);
    expect(indicator?.label).toBe("Peak time until 14:00");
  });
});
