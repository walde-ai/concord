import { SqlitePersistenceFactory, type SqlitePersistenceBundle } from "../../infra/adapters/stores/sqlite/sqlite-persistence-factory";
import { resolveDatabasePath } from "./compose";

export interface LocalDeps {
  readonly bundle: SqlitePersistenceBundle;
}

export function buildLocalDeps(databasePath: string = resolveDatabasePath()): LocalDeps {
  const factory = new SqlitePersistenceFactory(databasePath);
  const bundle = factory.create();
  return { bundle };
}

export async function closeLocalDeps(deps: LocalDeps): Promise<void> {
  await deps.bundle.database.close();
}
