import type { ContextDescriptor } from "../../context";
import type { ListQuery, ListResult } from "../../list";

export interface ListContexts {
  list(query: ListQuery): Promise<ListResult<ContextDescriptor>>;
}
