import type { RunAbortRegistry, AbortHandle } from "../../../domain/ports/out/run-abort-registry";

export class InMemoryRunAbortRegistry implements RunAbortRegistry {
  private readonly handles: Map<string, AbortHandle> = new Map();

  public register(runId: string, handle: AbortHandle): void {
    this.handles.set(runId, handle);
  }

  public lookup(runId: string): AbortHandle | null {
    return this.handles.get(runId) ?? null;
  }

  public unregister(runId: string): void {
    this.handles.delete(runId);
  }
}
