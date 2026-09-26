import type { ContextStore } from "../../../domain/ports/out/context-store";
import type { Context } from "../../../domain/entities/context";
import type { Result } from "../../../domain/result";
import { success } from "../../../domain/result";
import type { ConcordError } from "../../../domain/exceptions/errors";
import { ContextNotFoundError } from "../../../domain/exceptions/errors";
import type { ListQuery, ListResult } from "../../../domain/list";

export class InMemoryContextStore implements ContextStore {
  private readonly contexts: Map<string, Context> = new Map();

  public async getByName(name: string): Promise<Context> {
    const context = this.contexts.get(name);
    if (context === undefined) {
      throw new ContextNotFoundError(name);
    }
    return context;
  }

  public async exists(name: string): Promise<boolean> {
    return this.contexts.has(name);
  }

  public async save(context: Context): Promise<Result<void, ConcordError>> {
    this.contexts.set(context.name, context);
    return success(undefined);
  }

  public async delete(name: string): Promise<Result<void, ConcordError>> {
    this.contexts.delete(name);
    return success(undefined);
  }

  public async list(query: ListQuery): Promise<ListResult<Context>> {
    const entries = [...this.contexts.values()];
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const total = entries.length;
    const items = entries.slice(query.offset, query.offset + query.limit);
    return { items, total, limit: query.limit, offset: query.offset };
  }
}
