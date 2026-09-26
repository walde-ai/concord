import type { RunRepository } from "../../../domain/ports/out/run-repository";
import type { Run } from "../../../domain/entities/run";
import type { RunState } from "../../../domain/entities/run";
import type { Result } from "../../../domain/result";
import { success } from "../../../domain/result";
import type { ConcordError } from "../../../domain/exceptions/errors";
import { RunNotFoundError } from "../../../domain/exceptions/errors";
import type { ListQuery, ListResult } from "../../../domain/list";

export class InMemoryRunRepository implements RunRepository {
  private readonly runs: Map<string, Run<unknown>> = new Map();
  private readonly insertionOrder: string[] = [];

  public async save(run: Run<unknown>): Promise<Result<void, ConcordError>> {
    if (!this.runs.has(run.id)) {
      this.insertionOrder.push(run.id);
    }
    this.runs.set(run.id, run);
    return success(undefined);
  }

  public async getById(id: string): Promise<Run<unknown>> {
    const run = this.runs.get(id);
    if (run === undefined) {
      throw new RunNotFoundError(id);
    }
    return run;
  }

  public async list(query: ListQuery): Promise<ListResult<Run<unknown>>> {
    const indexed = this.collectIndexed();
    indexed.sort((a, b) => {
      const byDate = b.run.event.datetime.getTime() - a.run.event.datetime.getTime();
      if (byDate !== 0) {
        return byDate;
      }
      return b.index - a.index;
    });
    const total = indexed.length;
    const items = indexed.slice(query.offset, query.offset + query.limit).map((entry) => entry.run);
    return { items, total, limit: query.limit, offset: query.offset };
  }

  public async listByEventId(eventId: string, query: ListQuery): Promise<ListResult<Run<unknown>>> {
    const indexed = this.collectIndexed().filter((entry) => entry.run.event.id === eventId);
    indexed.sort((a, b) => {
      const byDate = b.run.event.datetime.getTime() - a.run.event.datetime.getTime();
      if (byDate !== 0) {
        return byDate;
      }
      return b.index - a.index;
    });
    const total = indexed.length;
    const items = indexed.slice(query.offset, query.offset + query.limit).map((entry) => entry.run);
    return { items, total, limit: query.limit, offset: query.offset };
  }

  public async listByState(state: RunState, query: ListQuery): Promise<ListResult<Run<unknown>>> {
    const indexed = this.collectIndexed().filter((entry) => entry.run.state === state);
    indexed.sort((a, b) => b.index - a.index);
    const total = indexed.length;
    const items = indexed.slice(query.offset, query.offset + query.limit).map((entry) => entry.run);
    return { items, total, limit: query.limit, offset: query.offset };
  }

  public async listByConsumer(consumerId: string, query: ListQuery): Promise<ListResult<Run<unknown>>> {
    const indexed = this.collectIndexed().filter((entry) => entry.run.consumerId === consumerId);
    indexed.sort((a, b) => {
      const byDate = b.run.event.datetime.getTime() - a.run.event.datetime.getTime();
      if (byDate !== 0) {
        return byDate;
      }
      return b.index - a.index;
    });
    const total = indexed.length;
    const items = indexed.slice(query.offset, query.offset + query.limit).map((entry) => entry.run);
    return { items, total, limit: query.limit, offset: query.offset };
  }

  private collectIndexed(): { run: Run<unknown>; index: number }[] {
    const result: { run: Run<unknown>; index: number }[] = [];
    this.insertionOrder.forEach((id, index) => {
      const run = this.runs.get(id);
      if (run !== undefined) {
        result.push({ run, index });
      }
    });
    return result;
  }
}
