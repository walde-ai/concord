import type {
  PullRequestLifecycleStore,
  PrLifecycleState,
  StoredLifecycleEntry,
} from "./pull-request-lifecycle-store";

export class InMemoryPullRequestLifecycleStore implements PullRequestLifecycleStore {
  private readonly records: Map<string, PrLifecycleState> = new Map();

  public async get(key: string): Promise<PrLifecycleState | null> {
    return this.records.get(key) ?? null;
  }

  public async save(key: string, state: PrLifecycleState): Promise<void> {
    this.records.set(key, state);
  }

  public async list(): Promise<readonly StoredLifecycleEntry[]> {
    return [...this.records.entries()].map(([key, state]) => ({ key, state }));
  }
}
