import type { PeakHoursDto } from "./types";

export interface PeakIndicator {
  readonly peak: boolean;
  readonly label: string;
}

export function computePeakIndicator(peakHours: PeakHoursDto | null, now: Date = new Date()): PeakIndicator | null {
  if (peakHours === null || peakHours.start === peakHours.end) {
    return null;
  }
  const wall = wallClockInTimezone(now, peakHours.timezone);
  const current = wall.hour * 60 + wall.minute;
  const start = parseHHMM(peakHours.start);
  const end = parseHHMM(peakHours.end);
  const isPeak = start < end ? current >= start && current < end : current >= start || current < end;
  const boundaryMinutes = isPeak ? end : start;
  const nextBoundary = nextOccurrence(boundaryMinutes, now, peakHours.timezone);
  const formatted = formatLocal(nextBoundary);
  return {
    peak: isPeak,
    label: isPeak ? `Peak time until ${formatted}` : `Off peak until ${formatted}`,
  };
}

function nextOccurrence(minutes: number, now: Date, timezone: string): Date {
  const wall = toWall(minutes);
  const todayGuess = wallClockToInstant(now, timezone, wall);
  if (todayGuess.getTime() > now.getTime()) {
    return todayGuess;
  }
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  return wallClockToInstant(tomorrow, timezone, wall);
}

function formatLocal(instant: Date): string {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", hour12: false }).format(instant);
}

function wallClockInTimezone(now: Date, timezone: string): { readonly hour: number; readonly minute: number } {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(now);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
  return { hour: hour % 24, minute };
}

function parseHHMM(value: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  return match === null ? 0 : Number(match[1]) * 60 + Number(match[2]);
}

function toWall(minutes: number): { readonly hour: number; readonly minute: number } {
  return { hour: Math.floor(minutes / 60), minute: minutes % 60 };
}

function wallClockToInstant(reference: Date, timezone: string, wall: { readonly hour: number; readonly minute: number }): Date {
  const ymd = yearMonthDayInTimezone(reference, timezone);
  const guessUtc = Date.UTC(ymd.year, ymd.month - 1, ymd.day, wall.hour, wall.minute, 0, 0);
  const offsetFirst = offsetForInstant(guessUtc, timezone);
  const correctedFirst = guessUtc - offsetFirst * 60_000;
  const offsetSecond = offsetForInstant(correctedFirst, timezone);
  return new Date(correctedFirst + (offsetSecond - offsetFirst) * 60_000);
}

function yearMonthDayInTimezone(now: Date, timezone: string): { readonly year: number; readonly month: number; readonly day: number } {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(now);
  const year = Number(parts.find((part) => part.type === "year")?.value ?? "1970");
  const month = Number(parts.find((part) => part.type === "month")?.value ?? "1");
  const day = Number(parts.find((part) => part.type === "day")?.value ?? "1");
  return { year, month, day };
}

function offsetForInstant(instantMs: number, timezone: string): number {
  const formatter = new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "shortOffset" });
  const parts = formatter.formatToParts(new Date(instantMs));
  const offsetPart = parts.find((part) => part.type === "timeZoneName")?.value ?? "GMT";
  return parseOffset(offsetPart);
}

function parseOffset(value: string): number {
  const match = /^(?:GMT|UTC)?([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(value);
  if (match === null) {
    return 0;
  }
  const sign = match[1] === "+" ? 1 : -1;
  const hours = Number(match[2]);
  const minutes = match[3] !== undefined ? Number(match[3]) : 0;
  return sign * (hours * 60 + minutes);
}
