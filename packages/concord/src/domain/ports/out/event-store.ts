import type { Event } from "../../entities/event";
import type { Result } from "../../result";
import type { ConcordError } from "../../exceptions/errors";
import type { ListQuery, ListResult } from "../../list";

export interface EventStore {
  save(event: Event<unknown>): Promise<Result<void, ConcordError>>;
  existsByProducerKey(producerId: string, producerEventId: string): Promise<boolean>;
  getById(id: string): Promise<Event<unknown>>;
  list(query: ListQuery): Promise<ListResult<Event<unknown>>>;
}
