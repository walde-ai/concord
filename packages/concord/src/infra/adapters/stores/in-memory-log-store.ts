import type { LogEntry } from "../../../domain/ports/out/logger";
import {
  LOG_FIELD_CONSUMER_ID,
  LOG_FIELD_EVENT_ID,
  LOG_FIELD_RUN_ID,
} from "../../../domain/ports/out/log-context";
import type { LogStore, LogStoreQuery, LogStoreResult } from "../../../domain/ports/out/log-store";

export class InMemoryLogStore implements LogStore {
  private readonly entries: LogEntry[] = [];

  public async append(entry: LogEntry): Promise<void> {
    this.entries.push(entry);
  }

  public async query(query: LogStoreQuery): Promise<LogStoreResult> {
    let filtered = [...this.entries];

    if (query.level !== undefined) {
      filtered = filtered.filter((entry) => entry.level === query.level);
    }
    if (query.source !== undefined) {
      filtered = filtered.filter((entry) => entry.source === query.source);
    }
    if (query.text !== undefined) {
      filtered = filtered.filter((entry) => entry.message.includes(query.text!));
    }
    if (query.startTime !== undefined) {
      filtered = filtered.filter((entry) => entry.timestamp >= query.startTime!);
    }
    if (query.endTime !== undefined) {
      filtered = filtered.filter((entry) => entry.timestamp <= query.endTime!);
    }
    if (query.eventId !== undefined) {
      filtered = filtered.filter((entry) => readField(entry, LOG_FIELD_EVENT_ID) === query.eventId);
    }
    if (query.runId !== undefined) {
      filtered = filtered.filter((entry) => readField(entry, LOG_FIELD_RUN_ID) === query.runId);
    }
    if (query.consumerId !== undefined) {
      filtered = filtered.filter((entry) => readField(entry, LOG_FIELD_CONSUMER_ID) === query.consumerId);
    }

    const total = filtered.length;
    const offset = query.offset;
    const items = filtered.slice(offset, offset + query.limit);

    return { items, total, limit: query.limit, offset: query.offset };
  }

  public async distinctSources(): Promise<string[]> {
    const sources = new Set<string>();
    for (const entry of this.entries) {
      sources.add(entry.source);
    }
    return [...sources].sort();
  }
}

function readField(entry: LogEntry, key: string): unknown {
  if (entry.fields === undefined) {
    return undefined;
  }
  return entry.fields[key];
}
