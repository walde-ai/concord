import type { RunTimeoutClock, RunTimeoutHandle } from "../../../domain/ports/out/run-timeout-clock";

export class InMemoryRunTimeoutClock implements RunTimeoutClock {
  private readonly handles: Map<string, RunTimeoutHandle> = new Map();

  public register(runId: string, handle: RunTimeoutHandle): void {
    this.handles.set(runId, handle);
  }

  public unregister(runId: string): void {
    this.handles.delete(runId);
  }

  public pause(runId: string): void {
    const handle = this.handles.get(runId);
    if (handle !== undefined) {
      handle.pause();
    }
  }

  public resume(runId: string): void {
    const handle = this.handles.get(runId);
    if (handle !== undefined) {
      handle.resume();
    }
  }
}
