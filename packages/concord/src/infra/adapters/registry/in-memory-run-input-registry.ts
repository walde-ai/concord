import type { RunInputRegistry, RunInputHandle } from "../../../domain/ports/out/run-input-registry";

export class InMemoryRunInputRegistry implements RunInputRegistry {
  private readonly handles: Map<string, RunInputHandle> = new Map();

  public register(runId: string, handle: RunInputHandle): void {
    this.handles.set(runId, handle);
  }

  public lookup(runId: string): RunInputHandle | null {
    return this.handles.get(runId) ?? null;
  }

  public unregister(runId: string): void {
    this.handles.delete(runId);
  }
}
