import type { Context } from "../../entities/context";
import type { Result } from "../../result";
import type { ConcordError } from "../../exceptions/errors";
import type { ListQuery, ListResult } from "../../list";

export interface ContextStore {
  getByName(name: string): Promise<Context>;
  exists(name: string): Promise<boolean>;
  save(context: Context): Promise<Result<void, ConcordError>>;
  delete(name: string): Promise<Result<void, ConcordError>>;
  list(query: ListQuery): Promise<ListResult<Context>>;
}
