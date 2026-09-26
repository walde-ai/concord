import type { Run } from "../../entities/run";

export interface AbortHandle {
  readonly controller: AbortController;
  readonly completion: Promise<Run<unknown>>;
  resolve(run: Run<unknown>): void;
}

export interface RunAbortRegistry {
  register(runId: string, handle: AbortHandle): void;
  lookup(runId: string): AbortHandle | null;
  unregister(runId: string): void;
}
