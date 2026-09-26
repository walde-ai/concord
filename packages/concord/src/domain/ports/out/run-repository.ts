import type { Run } from "../../entities/run";
import type { RunState } from "../../entities/run";
import type { Result } from "../../result";
import type { ConcordError } from "../../exceptions/errors";
import type { ListQuery, ListResult } from "../../list";

export interface RunRepository {
  save(run: Run<unknown>): Promise<Result<void, ConcordError>>;
  getById(id: string): Promise<Run<unknown>>;
  list(query: ListQuery): Promise<ListResult<Run<unknown>>>;
  listByEventId(eventId: string, query: ListQuery): Promise<ListResult<Run<unknown>>>;
  listByState(state: RunState, query: ListQuery): Promise<ListResult<Run<unknown>>>;
  listByConsumer(consumerId: string, query: ListQuery): Promise<ListResult<Run<unknown>>>;
}
