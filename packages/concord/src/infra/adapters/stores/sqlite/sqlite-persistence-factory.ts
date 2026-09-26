import { join, dirname } from "node:path";
import { mkdirSync } from "node:fs";

import { SqliteDatabase } from "./sqlite-database";
import { SqliteEventStore } from "./sqlite-event-store";
import { SqliteRunRepository } from "./sqlite-run-repository";
import { SqliteProducerStateRepository } from "./sqlite-producer-state-repository";
import { SqliteConsumerStateRepository } from "./sqlite-consumer-state-repository";
import { SqliteConsumerConfigRepository } from "./sqlite-consumer-config-repository";
import { SqlitePeakHoursRepository } from "./sqlite-peak-hours-repository";
import { SqliteContextStore } from "./sqlite-context-store";
import { SqliteCredentialStore } from "./sqlite-credential-store";
import { SqlitePauseStateRepository } from "./sqlite-pause-state-repository";
import { SqliteFormRepository } from "./sqlite-form-repository";
import { SqliteRunUpdateRepository } from "./sqlite-run-update-repository";
import { SqliteLogStore } from "./sqlite-log-store";
import { SqliteSessionStore } from "./sqlite-session-store";
import { SqlitePullRequestLifecycleStore } from "./sqlite-pull-request-lifecycle-store";

export interface SqlitePersistenceBundle {
  readonly database: SqliteDatabase;
  readonly eventStore: SqliteEventStore;
  readonly runRepository: SqliteRunRepository;
  readonly producerStateRepository: SqliteProducerStateRepository;
  readonly consumerStateRepository: SqliteConsumerStateRepository;
  readonly consumerConfigRepository: SqliteConsumerConfigRepository;
  readonly peakHoursRepository: SqlitePeakHoursRepository;
  readonly contextStore: SqliteContextStore;
  readonly credentialStore: SqliteCredentialStore;
  readonly pauseStateRepository: SqlitePauseStateRepository;
  readonly formRepository: SqliteFormRepository;
  readonly runUpdateRepository: SqliteRunUpdateRepository;
  readonly logStore: SqliteLogStore;
  readonly sessionStore: SqliteSessionStore;
  readonly pullRequestLifecycleStore: SqlitePullRequestLifecycleStore;
}

export class SqlitePersistenceFactory {
  public readonly filePath: string;

  public constructor(filePath: string = join(process.cwd(), ".concord", "concord.db")) {
    this.filePath = filePath;
  }

  public create(): SqlitePersistenceBundle {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const database = new SqliteDatabase(this.filePath);
    const eventStore = new SqliteEventStore(database);
    const runRepository = new SqliteRunRepository(database);
    const producerStateRepository = new SqliteProducerStateRepository(database);
    const consumerStateRepository = new SqliteConsumerStateRepository(database);
    const consumerConfigRepository = new SqliteConsumerConfigRepository(database);
    const peakHoursRepository = new SqlitePeakHoursRepository(database);
    const contextStore = new SqliteContextStore(database);
    const credentialStore = new SqliteCredentialStore(database);
    const pauseStateRepository = new SqlitePauseStateRepository(database);
    const formRepository = new SqliteFormRepository(database);
    const runUpdateRepository = new SqliteRunUpdateRepository(database);
    const retentionDays = Number(process.env.CONCORD_LOG_RETENTION_DAYS ?? "30");
    const logStore = new SqliteLogStore(database, retentionDays);
    const sessionStore = new SqliteSessionStore(database);
    const pullRequestLifecycleStore = new SqlitePullRequestLifecycleStore(database);
    return {
      database,
      eventStore,
      runRepository,
      producerStateRepository,
      consumerStateRepository,
      consumerConfigRepository,
      peakHoursRepository,
      contextStore,
      credentialStore,
      pauseStateRepository,
      formRepository,
      runUpdateRepository,
      logStore,
      sessionStore,
      pullRequestLifecycleStore,
    };
  }
}
