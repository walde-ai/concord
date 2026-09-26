import type { RunUpdateRepository } from "../../../domain/ports/out/run-update-repository";
import type { RunUpdate } from "../../../domain/entities/run-update";

export class InMemoryRunUpdateRepository implements RunUpdateRepository {
  private readonly updates: RunUpdate[] = [];

  public async save(update: RunUpdate): Promise<void> {
    this.updates.push(update);
  }

  public async listByRun(runId: string): Promise<RunUpdate[]> {
    const matching: RunUpdate[] = [];
    for (const update of this.updates) {
      if (update.runId === runId) {
        matching.push(update);
      }
    }
    matching.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    return matching;
  }
}
