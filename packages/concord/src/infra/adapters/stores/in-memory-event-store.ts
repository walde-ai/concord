import type { EventStore } from "../../../domain/ports/out/event-store";
import type { Event } from "../../../domain/entities/event";
import type { Result } from "../../../domain/result";
import { success } from "../../../domain/result";
import { ConcordError, EventNotFoundError } from "../../../domain/exceptions/errors";
import type { ListQuery, ListResult } from "../../../domain/list";

export class InMemoryEventStore implements EventStore {
  private readonly events: Map<string, Event<unknown>> = new Map();

  public async save(event: Event<unknown>): Promise<Result<void, ConcordError>> {
    this.events.set(event.id, event);
    return success(undefined);
  }

  public async existsByProducerKey(producerId: string, producerEventId: string): Promise<boolean> {
    return [...this.events.values()].some(
      (event) => event.producerId === producerId && event.producerEventId === producerEventId,
    );
  }

  public async getById(id: string): Promise<Event<unknown>> {
    const event = this.events.get(id);
    if (event === undefined) {
      throw new EventNotFoundError(id);
    }
    return event;
  }

  public async list(query: ListQuery): Promise<ListResult<Event<unknown>>> {
    const entries = [...this.events.values()];
    entries.sort((a, b) => b.datetime.getTime() - a.datetime.getTime());
    const total = entries.length;
    const items = entries.slice(query.offset, query.offset + query.limit);
    return { items, total, limit: query.limit, offset: query.offset };
  }

  public all(): Event<unknown>[] {
    return [...this.events.values()];
  }
}
