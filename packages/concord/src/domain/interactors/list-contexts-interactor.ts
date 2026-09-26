import type { ListContexts } from "../ports/in/list-contexts";
import type { ContextStore } from "../ports/out/context-store";
import type { ContextDescriptor } from "../context";
import type { ListQuery, ListResult } from "../list";

export class ListContextsInteractor implements ListContexts {
  public constructor(private readonly store: ContextStore) {}

  public async list(query: ListQuery): Promise<ListResult<ContextDescriptor>> {
    const result = await this.store.list(query);
    const items = result.items.map((context) => ({
      name: context.name,
      payload: context.payload,
      secrets: { ...context.secrets },
    }));
    return {
      items,
      total: result.total,
      limit: result.limit,
      offset: result.offset,
    };
  }
}
