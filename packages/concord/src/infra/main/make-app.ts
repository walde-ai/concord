import type { EventStore } from "../../domain/ports/out/event-store";
import type { RunRepository } from "../../domain/ports/out/run-repository";
import type { ProducerStateRepository } from "../../domain/ports/out/producer-state-repository";
import type { ConsumerStateRepository } from "../../domain/ports/out/consumer-state-repository";
import type { ConsumerConfigRepository } from "../../domain/ports/out/consumer-config-repository";
import type { ConsumerConfigResolver } from "../../domain/ports/out/consumer-config-resolver";
import type { ConsumerSecretResolver } from "../../domain/ports/out/consumer-secret-resolver";
import type { PeakHoursRepository } from "../../domain/ports/out/peak-hours-repository";
import type { PeakSchedule } from "../../domain/ports/out/peak-schedule";
import type { PauseStateRepository } from "../../domain/ports/out/pause-state-repository";
import type { RunAbortRegistry } from "../../domain/ports/out/run-abort-registry";
import type { RunTimeoutClock } from "../../domain/ports/out/run-timeout-clock";
import type { RunTimeoutResolver } from "../../domain/ports/out/run-timeout-resolver";
import type { FormRepository } from "../../domain/ports/out/form-repository";
import type { RunUpdateRepository } from "../../domain/ports/out/run-update-repository";
import type { RunInputRegistry } from "../../domain/ports/out/run-input-registry";
import type { ContextStore } from "../../domain/ports/out/context-store";
import type { CredentialStore } from "../../domain/ports/out/credential-store";
import type { ContextResolver } from "../../domain/ports/out/context-resolver";
import type { IdGenerator } from "../../domain/ports/out/id-generator";
import type { Clock } from "../../domain/ports/out/clock";
import type { EventLifecycleObserver } from "../../domain/ports/out/event-lifecycle-observer";
import type { Logger } from "../../domain/ports/out/logger";
import type { LogStore } from "../../domain/ports/out/log-store";
import type { LogContextScope } from "../../domain/ports/out/log-context";
import type { SessionStore } from "../../domain/ports/out/session-store";
import type { RunCompletionHook } from "../../domain/ports/out/run-completion-hook";
import type { Closeable } from "./closeable";
import type { Startable } from "./startable";
import type { AuthConfig } from "./auth-config";
import { defaultAuthConfig } from "./auth-config";
import { SignalEventInteractor } from "../../domain/interactors/signal-event-interactor";
import { RunDispatcher } from "../../domain/interactors/run-dispatcher";
import { GetPauseStateInteractor } from "../../domain/interactors/get-pause-state-interactor";
import { SetPauseStateInteractor } from "../../domain/interactors/set-pause-state-interactor";
import { ReplayEventInteractor } from "../../domain/interactors/replay-event-interactor";
import { AbortRunInteractor } from "../../domain/interactors/abort-run-interactor";
import { RestartRunInteractor } from "../../domain/interactors/restart-run-interactor";
import { RequestRunInputInteractor } from "../../domain/interactors/request-run-input-interactor";
import { SubmitRunInputInteractor } from "../../domain/interactors/submit-run-input-interactor";
import { RecordRunUpdateInteractor } from "../../domain/interactors/record-run-update-interactor";
import { ListProducersInteractor } from "../../domain/interactors/list-producers-interactor";
import { ListConsumersInteractor } from "../../domain/interactors/list-consumers-interactor";
import { ListEventTemplatesInteractor } from "../../domain/interactors/list-event-templates-interactor";
import { EmitEventTemplateInteractor } from "../../domain/interactors/emit-event-template-interactor";
import { ResolveEventTemplateFieldOptionsInteractor } from "../../domain/interactors/resolve-event-template-field-options-interactor";
import { QueryLogsInteractor } from "../../domain/interactors/query-logs-interactor";
import { ConsumerDescriptorBuilder } from "../../domain/interactors/consumer-descriptor-builder";
import { SetProducerEnabledInteractor } from "../../domain/interactors/set-producer-enabled-interactor";
import { SetConsumerEnabledInteractor } from "../../domain/interactors/set-consumer-enabled-interactor";
import { SetConsumerConfigInteractor } from "../../domain/interactors/set-consumer-config-interactor";
import { SetConsumerSecretsInteractor } from "../../domain/interactors/set-consumer-secrets-interactor";
import { SetConsumerWaitForOffPeakInteractor } from "../../domain/interactors/set-consumer-wait-for-off-peak-interactor";
import { GetPeakHoursInteractor } from "../../domain/interactors/get-peak-hours-interactor";
import { SetPeakHoursInteractor } from "../../domain/interactors/set-peak-hours-interactor";
import { CreateContextInteractor } from "../../domain/interactors/create-context-interactor";
import { UpdateContextInteractor } from "../../domain/interactors/update-context-interactor";
import { DeleteContextInteractor } from "../../domain/interactors/delete-context-interactor";
import { ListContextsInteractor } from "../../domain/interactors/list-contexts-interactor";
import { CreateUserInteractor } from "../../domain/interactors/create-user-interactor";
import { DeleteUserInteractor } from "../../domain/interactors/delete-user-interactor";
import { BeginLoginInteractor } from "../../domain/interactors/begin-login-interactor";
import { CompleteLoginInteractor } from "../../domain/interactors/complete-login-interactor";
import { AuthenticateRequestInteractor } from "../../domain/interactors/authenticate-request-interactor";
import { EmitEventInteractor } from "../../domain/interactors/emit-event-interactor";
import { InMemoryEventStore } from "../adapters/stores/in-memory-event-store";
import { InMemoryRunRepository } from "../adapters/stores/in-memory-run-repository";
import { InMemoryProducerStateRepository } from "../adapters/stores/in-memory-producer-state-repository";
import { InMemoryConsumerStateRepository } from "../adapters/stores/in-memory-consumer-state-repository";
import { InMemoryConsumerConfigRepository } from "../adapters/stores/in-memory-consumer-config-repository";
import { InMemoryPeakHoursRepository } from "../adapters/stores/in-memory-peak-hours-repository";
import { InMemoryPauseStateRepository } from "../adapters/stores/in-memory-pause-state-repository";
import { InMemoryContextStore } from "../adapters/stores/in-memory-context-store";
import { InMemoryCredentialStore } from "../adapters/stores/in-memory-credential-store";
import { InMemoryRunAbortRegistry } from "../adapters/registry/in-memory-run-abort-registry";
import { InMemoryRunInputRegistry } from "../adapters/registry/in-memory-run-input-registry";
import { InMemoryRunTimeoutClock } from "../adapters/registry/in-memory-run-timeout-clock";
import { WorktreeLeaseRegistry } from "../adapters/git/worktree-lease-registry";
import { CompositeRunCompletionHook } from "../../domain/ports/out/run-completion-hook";
import { InMemoryFormRepository } from "../adapters/stores/in-memory-form-repository";
import { InMemoryRunUpdateRepository } from "../adapters/stores/in-memory-run-update-repository";
import { InMemoryLogStore } from "../adapters/stores/in-memory-log-store";
import { SqlitePersistenceFactory } from "../adapters/stores/sqlite/sqlite-persistence-factory";
import type { PullRequestLifecycleStore } from "../adapters/producers/github/pull-request-lifecycle-store";
import { InMemoryPullRequestLifecycleStore } from "../adapters/producers/github/in-memory-pull-request-lifecycle-store";
import { EventEmittingContextResolver, CONCORD_PRODUCER_ID } from "../adapters/context/event-emitting-context-resolver";
import { REPLAY_PRODUCER_ID } from "../adapters/replay/replay-producer-id";
import { CONCORD_RUN_INPUT_PRODUCER_ID } from "../../domain/events/run-input-event";
import { InlineProducer } from "../adapters/producers/inline/inline-producer";
import { CompositeEventLifecycleObserver } from "../adapters/api/composite-event-lifecycle-observer";
import { StreamBroadcaster } from "../adapters/api/stream-broadcaster";
import { HttpApiServer } from "../adapters/api/http-api-server";
import { NoOpRunActivityEmitter } from "../adapters/opencode/run-activity-emitter";
import type { RunActivityEmitter } from "../adapters/opencode/run-activity-emitter";
import { InMemoryWidgetRegistry } from "../adapters/widgets/widget-registry";
import { InMemoryConsumerRegistry } from "../adapters/registry/in-memory-consumer-registry";
import { InMemoryProducerRegistry } from "../adapters/registry/in-memory-producer-registry";
import { InMemoryEventTemplateRegistry } from "../adapters/registry/in-memory-event-template-registry";
import { GitWorktreeManager } from "../adapters/git/git-worktree-manager";
import { RawJsonEventTemplate } from "../adapters/event-templates/raw-json-event-template";
import { UuidIdGenerator } from "../adapters/system/uuid-id-generator";
import { SystemClock } from "../adapters/system/system-clock";
import { StructuredLogger } from "../adapters/system/structured-logger";
import { AsyncLogContextScope } from "../adapters/system/async-log-context-scope";
import { MergingConsumerConfigResolver } from "../adapters/config/merging-consumer-config-resolver";
import { ConfigRunTimeoutResolver, DEFAULT_RUN_TIMEOUT_MS } from "../adapters/config/config-run-timeout-resolver";
import { RepositoryConsumerSecretResolver } from "../adapters/config/repository-consumer-secret-resolver";
import { IntlPeakSchedule } from "../adapters/scheduling/intl-peak-schedule";
import { OffPeakScheduler } from "../adapters/scheduling/off-peak-scheduler";
import {
  Argon2PasswordSecretDeriver,
  TEST_ARGON2ID_PARAMETERS,
} from "../adapters/auth/argon2-password-secret-deriver";
import { SecureRemotePasswordIssuer } from "../adapters/auth/secure-remote-password-issuer";
import { SecureRemotePasswordHandshake } from "../adapters/auth/secure-remote-password-handshake";
import { NodeHmacSignatureVerifier } from "../adapters/auth/node-hmac-signature-verifier";
import { InMemoryHandshakeStore } from "../adapters/auth/in-memory-handshake-store";
import { InMemorySessionStore } from "../adapters/auth/in-memory-session-store";
import { InMemoryNonceCache } from "../adapters/auth/in-memory-nonce-cache";
import { CanonicalRequest } from "../adapters/auth/canonical-request";
import { App } from "./app";

export interface ApiConfig {
  readonly host: string;
  readonly port: number;
  readonly uiDir?: string;
}

export interface AppConfig {
  readonly eventStore?: EventStore;
  readonly runRepository?: RunRepository;
  readonly producerStateRepository?: ProducerStateRepository;
  readonly consumerStateRepository?: ConsumerStateRepository;
  readonly consumerConfigRepository?: ConsumerConfigRepository;
  readonly consumerSecretResolver?: ConsumerSecretResolver;
  readonly peakHoursRepository?: PeakHoursRepository;
  readonly pauseStateRepository?: PauseStateRepository;
  readonly contextStore?: ContextStore;
  readonly credentialStore?: CredentialStore;
  readonly formRepository?: FormRepository;
  readonly runUpdateRepository?: RunUpdateRepository;
  readonly idGenerator?: IdGenerator;
  readonly clock?: Clock;
  readonly peakSchedule?: PeakSchedule;
  readonly databasePath?: string;
  readonly api?: ApiConfig;
  readonly auth?: AuthConfig;
  readonly logger?: Logger;
  readonly logStore?: LogStore;
  readonly logContextScope?: LogContextScope;
  readonly sessionStore?: SessionStore;
  readonly pullRequestLifecycleStore?: PullRequestLifecycleStore;
  /** Deployment-specific completion hooks (e.g. terminal-failure notifiers)
   * appended to the composite hook the app already builds around the
   * worktree lease registry. */
  readonly runCompletionHooks?: readonly RunCompletionHook[];
}

interface Persistence {
  readonly eventStore: EventStore;
  readonly runRepository: RunRepository;
  readonly producerStateRepository: ProducerStateRepository;
  readonly consumerStateRepository: ConsumerStateRepository;
  readonly consumerConfigRepository: ConsumerConfigRepository;
  readonly peakHoursRepository: PeakHoursRepository;
  readonly pauseStateRepository: PauseStateRepository;
  readonly contextStore: ContextStore;
  readonly credentialStore: CredentialStore;
  readonly formRepository: FormRepository;
  readonly runUpdateRepository: RunUpdateRepository;
  readonly logStore: LogStore;
  readonly sessionStore: SessionStore;
  readonly pullRequestLifecycleStore: PullRequestLifecycleStore;
}

export function MakeApp(config: AppConfig = {}): App {
  const idGenerator = config.idGenerator ?? new UuidIdGenerator();
  const clock = config.clock ?? new SystemClock();
  const registry = new InMemoryConsumerRegistry();
  const producerRegistry = new InMemoryProducerRegistry();
  const eventTemplateRegistry = new InMemoryEventTemplateRegistry();
  const widgetRegistry = new InMemoryWidgetRegistry();
  const closeables: Closeable[] = [];
  const startables: Startable[] = [];

  const persistence = resolvePersistence(config, closeables);
  const logContextScope = config.logContextScope ?? new AsyncLogContextScope();
  const logger = config.logger ?? new StructuredLogger(clock, logContextScope, persistence.logStore);
  const abortRegistry: RunAbortRegistry = new InMemoryRunAbortRegistry();
  const timeoutClock: RunTimeoutClock = new InMemoryRunTimeoutClock();
  const peakSchedule = config.peakSchedule ?? new IntlPeakSchedule();

  const configResolver: ConsumerConfigResolver = new MergingConsumerConfigResolver(
    registry,
    persistence.consumerConfigRepository,
  );

  const secretResolver: ConsumerSecretResolver = config.consumerSecretResolver
    ?? new RepositoryConsumerSecretResolver(registry, persistence.consumerConfigRepository);

  const timeoutResolver: RunTimeoutResolver = new ConfigRunTimeoutResolver(configResolver, DEFAULT_RUN_TIMEOUT_MS);

  const observer = new CompositeEventLifecycleObserver();

  // Run-scoped worktree leases: handlers register the worktrees their runs
  // check out; the dispatcher-driven hook reclaims them when runs end. The
  // same instance is exposed on the App so the composition root (the server)
  // can hand it to the agent consumers factory.
  const worktreeLeases = new WorktreeLeaseRegistry(new GitWorktreeManager(), logger);
  const completionHook = new CompositeRunCompletionHook([
    worktreeLeases,
    ...(config.runCompletionHooks ?? []),
  ]);

  const runDispatcher = new RunDispatcher(
    persistence.runRepository,
    idGenerator,
    observer,
    abortRegistry,
    clock,
    persistence.peakHoursRepository,
    peakSchedule,
    persistence.consumerStateRepository,
    registry,
    timeoutResolver,
    timeoutClock,
    logger,
    logContextScope,
    completionHook,
  );

  const offPeakScheduler = new OffPeakScheduler(
    runDispatcher,
    persistence.runRepository,
    persistence.peakHoursRepository,
    peakSchedule,
    clock,
  );
  observer.add(offPeakScheduler);

  let broadcaster: StreamBroadcaster | null = null;
  if (config.api !== undefined) {
    broadcaster = new StreamBroadcaster();
    observer.add(broadcaster);
  }

  const eventSink = new SignalEventInteractor(
    persistence.eventStore,
    persistence.runRepository,
    registry,
    persistence.producerStateRepository,
    persistence.consumerStateRepository,
    idGenerator,
    clock,
    observer,
    persistence.pauseStateRepository,
    runDispatcher,
  );

  const contexts: ContextResolver = new EventEmittingContextResolver(
    persistence.contextStore,
    eventSink,
    idGenerator,
    clock,
  );

  producerRegistry.register({ producerId: CONCORD_PRODUCER_ID, disableable: false });

  const runInputRegistry: RunInputRegistry = new InMemoryRunInputRegistry();
  const runInputProducer = new InlineProducer(CONCORD_RUN_INPUT_PRODUCER_ID);
  runInputProducer.register({
    idGenerator,
    clock,
    contexts,
    addProducer: () => {},
    addConsumer: () => {},
    addEventTemplate: () => {},
  });
  producerRegistry.register({ producerId: CONCORD_RUN_INPUT_PRODUCER_ID, disableable: false });
  startables.push({ start: async () => { await runInputProducer.start(eventSink); } });

  const requestRunInput = new RequestRunInputInteractor(
    persistence.runRepository,
    persistence.formRepository,
    runInputRegistry,
    abortRegistry,
    timeoutClock,
    configResolver,
    runInputProducer,
    idGenerator,
    clock,
    observer,
  );
  const submitRunInput = new SubmitRunInputInteractor(
    persistence.formRepository,
    runInputRegistry,
    clock,
  );
  const recordRunUpdate = new RecordRunUpdateInteractor(
    persistence.runUpdateRepository,
    persistence.runRepository,
    idGenerator,
    clock,
  );

  startables.push(offPeakScheduler);
  closeables.push(offPeakScheduler);

  if (config.api !== undefined) {
    const auth = defaultAuthConfig(config.auth);

    const descriptorBuilder = new ConsumerDescriptorBuilder(registry, persistence.consumerStateRepository, configResolver, secretResolver);
    const listProducers = new ListProducersInteractor(producerRegistry, persistence.producerStateRepository);
    const listConsumers = new ListConsumersInteractor(registry, descriptorBuilder);
    const setProducerEnabled = new SetProducerEnabledInteractor(producerRegistry, persistence.producerStateRepository);
    const setConsumerEnabled = new SetConsumerEnabledInteractor(registry, persistence.consumerStateRepository);
    const setConsumerConfig = new SetConsumerConfigInteractor(registry, persistence.consumerConfigRepository, descriptorBuilder);
    const setConsumerSecrets = new SetConsumerSecretsInteractor(registry, persistence.consumerConfigRepository, descriptorBuilder);
    const setConsumerWaitForOffPeak = new SetConsumerWaitForOffPeakInteractor(persistence.consumerStateRepository, descriptorBuilder);
    const getPeakHours = new GetPeakHoursInteractor(persistence.peakHoursRepository);
    const setPeakHours = new SetPeakHoursInteractor(persistence.peakHoursRepository, observer);
    const createContext = new CreateContextInteractor(persistence.contextStore);
    const updateContext = new UpdateContextInteractor(persistence.contextStore);
    const deleteContext = new DeleteContextInteractor(persistence.contextStore);
    const listContexts = new ListContextsInteractor(persistence.contextStore);
    const getPauseState = new GetPauseStateInteractor(persistence.pauseStateRepository);
    const setPauseState = new SetPauseStateInteractor(persistence.pauseStateRepository, observer);
    const replayEvent = new ReplayEventInteractor(persistence.eventStore, eventSink, idGenerator, clock);
    const abortRun = new AbortRunInteractor(persistence.runRepository, abortRegistry, observer);
    const restartRun = new RestartRunInteractor(
      persistence.runRepository,
      registry,
      persistence.consumerStateRepository,
      runDispatcher,
    );

    const deriver = new Argon2PasswordSecretDeriver(auth.argon2);
    const issuer = new SecureRemotePasswordIssuer(deriver);
    const handshake = new SecureRemotePasswordHandshake(auth.pepper);
    const handshakeStore = new InMemoryHandshakeStore(auth.handshakeTtlMs);
    const sessionStore = persistence.sessionStore;
    const nonceCache = new InMemoryNonceCache(auth.freshnessWindowMs);
    const signatureVerifier = new NodeHmacSignatureVerifier();
    const canonical = new CanonicalRequest();

    const beginLogin = new BeginLoginInteractor(persistence.credentialStore, handshake, handshakeStore, idGenerator);
    const completeLogin = new CompleteLoginInteractor(
      handshakeStore,
      persistence.credentialStore,
      handshake,
      sessionStore,
      idGenerator,
      clock,
      auth.sessionLifetimeMs,
    );
    const authenticateRequest = new AuthenticateRequestInteractor(
      sessionStore,
      signatureVerifier,
      nonceCache,
      clock,
      canonical,
      auth.freshnessWindowMs,
    );
    const emitEvent = new EmitEventInteractor(eventSink, idGenerator, clock);
    const createUser = new CreateUserInteractor(persistence.credentialStore, issuer);
    const deleteUser = new DeleteUserInteractor(persistence.credentialStore);

    eventTemplateRegistry.register(new RawJsonEventTemplate());
    const listEventTemplates = new ListEventTemplatesInteractor(eventTemplateRegistry, contexts);
    const emitEventTemplate = new EmitEventTemplateInteractor(eventTemplateRegistry, eventSink, idGenerator, clock, contexts);
    const resolveEventTemplateFieldOptions = new ResolveEventTemplateFieldOptionsInteractor(eventTemplateRegistry, contexts);
    producerRegistry.register({ producerId: "web-ui", disableable: false });
    producerRegistry.register({ producerId: "cli", disableable: false });
    producerRegistry.register({ producerId: REPLAY_PRODUCER_ID, disableable: false });

    const queryLogs = new QueryLogsInteractor(persistence.logStore);

    const server = new HttpApiServer(
      config.api.host,
      config.api.port,
      persistence.eventStore,
      persistence.runRepository,
      broadcaster as StreamBroadcaster,
      listProducers,
      listConsumers,
      setProducerEnabled,
      setConsumerEnabled,
      createContext,
      updateContext,
      deleteContext,
      listContexts,
      beginLogin,
      completeLogin,
      authenticateRequest,
      emitEvent,
      getPauseState,
      setPauseState,
      replayEvent,
      abortRun,
      restartRun,
      getPeakHours,
      setPeakHours,
      setConsumerWaitForOffPeak,
      setConsumerConfig,
      setConsumerSecrets,
      submitRunInput,
      persistence.formRepository,
      persistence.runUpdateRepository,
      listEventTemplates,
      emitEventTemplate,
      resolveEventTemplateFieldOptions,
      queryLogs,
      persistence.logStore,
      config.api.uiDir,
      widgetRegistry,
    );
    startables.push(server);
    closeables.push(server);
  }

  const runActivityEmitter: RunActivityEmitter = broadcaster ?? new NoOpRunActivityEmitter();

  return new App(eventSink, registry, producerRegistry, eventTemplateRegistry, idGenerator, clock, contexts, configResolver, secretResolver, persistence.runRepository, observer, logger, requestRunInput, recordRunUpdate, submitRunInput, persistence.formRepository, runActivityEmitter, widgetRegistry, runDispatcher, closeables, startables, persistence.pullRequestLifecycleStore, persistence.consumerStateRepository, worktreeLeases);
}

function resolvePersistence(config: AppConfig, closeables: Closeable[]): Persistence {
  if (config.eventStore === undefined && config.runRepository === undefined) {
    const factory = new SqlitePersistenceFactory(config.databasePath);
    const bundle = factory.create();
    closeables.push(bundle.database);
    return {
      eventStore: bundle.eventStore,
      runRepository: bundle.runRepository,
      producerStateRepository: bundle.producerStateRepository,
      consumerStateRepository: bundle.consumerStateRepository,
      consumerConfigRepository: config.consumerConfigRepository ?? bundle.consumerConfigRepository,
      peakHoursRepository: config.peakHoursRepository ?? bundle.peakHoursRepository,
      pauseStateRepository: config.pauseStateRepository ?? bundle.pauseStateRepository,
      contextStore: config.contextStore ?? bundle.contextStore,
      credentialStore: config.credentialStore ?? bundle.credentialStore,
      formRepository: config.formRepository ?? bundle.formRepository,
      runUpdateRepository: config.runUpdateRepository ?? bundle.runUpdateRepository,
      logStore: config.logStore ?? bundle.logStore,
      sessionStore: config.sessionStore ?? bundle.sessionStore,
      pullRequestLifecycleStore: config.pullRequestLifecycleStore ?? bundle.pullRequestLifecycleStore,
    };
  } else {
    return {
      eventStore: config.eventStore ?? new InMemoryEventStore(),
      runRepository: config.runRepository ?? new InMemoryRunRepository(),
      producerStateRepository: config.producerStateRepository ?? new InMemoryProducerStateRepository(),
      consumerStateRepository: config.consumerStateRepository ?? new InMemoryConsumerStateRepository(),
      consumerConfigRepository: config.consumerConfigRepository ?? new InMemoryConsumerConfigRepository(),
      peakHoursRepository: config.peakHoursRepository ?? new InMemoryPeakHoursRepository(),
      pauseStateRepository: config.pauseStateRepository ?? new InMemoryPauseStateRepository(),
      contextStore: config.contextStore ?? new InMemoryContextStore(),
      credentialStore: config.credentialStore ?? new InMemoryCredentialStore(),
      formRepository: config.formRepository ?? new InMemoryFormRepository(),
      runUpdateRepository: config.runUpdateRepository ?? new InMemoryRunUpdateRepository(),
      logStore: config.logStore ?? new InMemoryLogStore(),
      sessionStore: config.sessionStore ?? new InMemorySessionStore(),
      pullRequestLifecycleStore: config.pullRequestLifecycleStore ?? new InMemoryPullRequestLifecycleStore(),
    };
  }
}

export { TEST_ARGON2ID_PARAMETERS };
