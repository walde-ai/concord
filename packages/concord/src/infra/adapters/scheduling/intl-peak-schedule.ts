import type { PeakSchedule } from "../../../domain/ports/out/peak-schedule";
import type { PeakHours } from "../../../domain/peak-hours";

interface WallClock {
  readonly hour: number;
  readonly minute: number;
}

export class IntlPeakSchedule implements PeakSchedule {
  public isPeakAt(peakHours: PeakHours | null, now: Date): boolean {
    if (peakHours === null) {
      return false;
    }
    if (peakHours.start === peakHours.end) {
      return false;
    }
    const wall = this.wallClockInTimezone(now, peakHours.timezone);
    const current = wall.hour * 60 + wall.minute;
    const start = parseHHMM(peakHours.start);
    const end = parseHHMM(peakHours.end);
    if (start < end) {
      return current >= start && current < end;
    }
    return current >= start || current < end;
  }

  public nextOffPeakBoundary(peakHours: PeakHours | null, now: Date): Date | null {
    if (peakHours === null) {
      return null;
    }
    if (peakHours.start === peakHours.end) {
      return null;
    }
    const endWall = parseHHMMToWallClock(peakHours.end);
    const boundaryToday = this.wallClockToInstant(now, peakHours.timezone, endWall);
    if (boundaryToday.getTime() > now.getTime()) {
      return boundaryToday;
    }
    const tomorrow = new Date(now.getTime() + MS_PER_DAY);
    return this.wallClockToInstant(tomorrow, peakHours.timezone, endWall);
  }

  private wallClockInTimezone(now: Date, timezone: string): WallClock {
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

  private wallClockToInstant(reference: Date, timezone: string, wall: WallClock): Date {
    const ymd = this.yearMonthDayInTimezone(reference, timezone);
    const guessUtc = Date.UTC(ymd.year, ymd.month - 1, ymd.day, wall.hour, wall.minute, 0, 0);
    const offsetFirst = this.offsetForInstant(guessUtc, timezone);
    const correctedFirst = guessUtc - offsetFirst * MS_PER_MINUTE;
    const offsetSecond = this.offsetForInstant(correctedFirst, timezone);
    return new Date(correctedFirst + (offsetSecond - offsetFirst) * MS_PER_MINUTE);
  }

  private yearMonthDayInTimezone(now: Date, timezone: string): { readonly year: number; readonly month: number; readonly day: number } {
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

  private offsetForInstant(instantMs: number, timezone: string): number {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      timeZoneName: "shortOffset",
    });
    const parts = formatter.formatToParts(new Date(instantMs));
    const offsetPart = parts.find((part) => part.type === "timeZoneName")?.value ?? "GMT";
    return parseOffset(offsetPart);
  }
}

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 24 * 60 * 60_000;

function parseHHMM(value: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (match === null) {
    return 0;
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

function parseHHMMToWallClock(value: string): WallClock {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (match === null) {
    return { hour: 0, minute: 0 };
  }
  return { hour: Number(match[1]), minute: Number(match[2]) };
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
