import type { Statement } from "better-sqlite3";
import type { PeakHoursRepository } from "../../../../domain/ports/out/peak-hours-repository";
import type { PeakHours } from "../../../../domain/peak-hours";
import type { SqliteDatabase } from "./sqlite-database";
import { PeakHoursV1 } from "./dto/peak-hours-v1";

export const PEAK_HOURS_ROW_ID = 1;

interface PeakHoursRow {
  start: string;
  end: string;
  timezone: string;
}

export class SqlitePeakHoursRepository implements PeakHoursRepository {
  private readonly upsert: Statement;
  private readonly selectById: Statement;
  private readonly deleteById: Statement;

  public constructor(database: SqliteDatabase) {
    this.upsert = database.prepare(
      "INSERT OR REPLACE INTO peak_hours (version, id, start, end, timezone) VALUES (?, ?, ?, ?, ?)",
    );
    this.selectById = database.prepare(
      "SELECT start, end, timezone FROM peak_hours WHERE id = ?",
    );
    this.deleteById = database.prepare("DELETE FROM peak_hours WHERE id = ?");
  }

  public async get(): Promise<PeakHours | null> {
    const row = this.selectById.get(PEAK_HOURS_ROW_ID) as PeakHoursRow | undefined;
    if (row === undefined) {
      return null;
    }
    return new PeakHoursV1(row.start, row.end, row.timezone).toDomain();
  }

  public async set(value: PeakHours | null): Promise<void> {
    if (value === null) {
      this.deleteById.run(PEAK_HOURS_ROW_ID);
      return;
    }
    const dto = PeakHoursV1.fromDomain(value);
    this.upsert.run(PeakHoursV1.version, PEAK_HOURS_ROW_ID, dto.start, dto.end, dto.timezone);
  }
}
