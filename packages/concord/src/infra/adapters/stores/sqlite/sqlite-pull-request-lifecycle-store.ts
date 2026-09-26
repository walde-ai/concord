import type { Statement } from "better-sqlite3";
import type {
  PullRequestLifecycleStore,
  PrLifecycleState,
  StoredLifecycleEntry,
} from "../../producers/github/pull-request-lifecycle-store";
import type { SqliteDatabase } from "./sqlite-database";
import { PullRequestLifecycleStateV1 } from "./dto/pull-request-lifecycle-state-v1";

interface LifecycleRow {
  version: string;
  key: string;
  state_json: string;
}

// SQLite-backed implementation of the GitHub PR producer's lifecycle store.
// The in-memory implementation loses every PR's tracked state on a server
// restart, which makes the producer re-emit pr.opened for all open PRs on
// every startup (and retrigger downstream consumers). Persisting the state
// here lets the producer resume exactly where it left off.
export class SqlitePullRequestLifecycleStore implements PullRequestLifecycleStore {
  private readonly upsert: Statement;
  private readonly selectByKey: Statement;
  private readonly selectAll: Statement;

  public constructor(database: SqliteDatabase) {
    this.upsert = database.prepare(
      "INSERT OR REPLACE INTO pr_lifecycle_state (version, key, state_json) VALUES (?, ?, ?)",
    );
    this.selectByKey = database.prepare(
      "SELECT version, key, state_json FROM pr_lifecycle_state WHERE key = ?",
    );
    this.selectAll = database.prepare(
      "SELECT version, key, state_json FROM pr_lifecycle_state",
    );
  }

  public async get(key: string): Promise<PrLifecycleState | null> {
    const row = this.selectByKey.get(key) as LifecycleRow | undefined;
    if (row === undefined) {
      return null;
    }
    return this.rowToState(row);
  }

  public async save(key: string, state: PrLifecycleState): Promise<void> {
    const dto = new PullRequestLifecycleStateV1(key, state);
    this.upsert.run(PullRequestLifecycleStateV1.version, key, dto.toJson());
  }

  public async list(): Promise<readonly StoredLifecycleEntry[]> {
    const rows = this.selectAll.all() as LifecycleRow[];
    return rows.map((row) => ({ key: row.key, state: this.rowToState(row) }));
  }

  private rowToState(row: LifecycleRow): PrLifecycleState {
    if (row.version === PullRequestLifecycleStateV1.version) {
      return PullRequestLifecycleStateV1.fromJson(row.key, row.state_json).state;
    }
    throw new Error(`Unknown pr_lifecycle_state version: ${row.version}`);
  }
}
