export { Event } from "./domain/entities/event";
export { Run, type RunState, RunFailure } from "./domain/entities/run";
export { Consumer } from "./domain/entities/consumer";
export { Context } from "./domain/entities/context";
export { Credential } from "./domain/entities/credential";
export { RunUpdate } from "./domain/entities/run-update";
export {
  RunForm,
  type FormStatus,
  type FieldInputType,
  type FieldDefinition,
  type ClosedChoiceFieldDefinition,
  type FreeTextFieldDefinition,
  type DynamicSelectFieldDefinition,
  type AnswerValue,
  type AnswerMap,
  type FormDefinition,
} from "./domain/entities/run-form";

export { type EventTemplateDescriptor, type EventTemplateEmission, type FieldOption } from "./domain/event-template";

export { type ProducerDescriptor, type ConsumerDescriptor, type ConsumerConfigParameter, type ConsumerConfigValues, type ConsumerConfigSecretParameter, type ConsumerConfigSecrets } from "./domain/component";
export { type PeakHours } from "./domain/peak-hours";
export { type ContextDescriptor, type SecretPair, type SecretOperation } from "./domain/context";
export { type UserDescriptor } from "./domain/user-descriptor";
export { type EventDescriptor } from "./domain/event-descriptor";

export { type Result, success, failure } from "./domain/result";

export {
  ConcordError,
  IllegalRunTransitionError,
  RunNotFoundError,
  RunNotAbortableError,
  RunNotRestartableError,
  EventNotFoundError,
  EventNotReplayableError,
  ProducerNotFoundError,
  ProducerNotDisableableError,
  ConsumerNotFoundError,
  ConsumerDisabledError,
  PersistenceError,
  EventHandlerError,
  UnexpectedHandlerError,
  RunSupersededError,
  UnexpectedStateError,
  ContextNotFoundError,
  ContextAlreadyExistsError,
  ContextResolveError,
  type ContextResolveReason,
  UserNotFoundError,
  UserAlreadyExistsError,
  AuthenticationError,
  InvalidProofError,
  HandshakeExpiredError,
  SessionExpiredError,
  StaleRequestError,
  ReplayDetectedError,
  InvalidSignatureError,
  InvalidPeakHoursError,
  type InvalidPeakHoursField,
  InvalidConsumerConfigError,
  MissingGitWorkingTreeError,
  FormNotFoundError,
  FormAlreadyAnsweredError,
  RunNotPendingInputError,
  InvalidFormAnswersError,
  InputRoundsExceededError,
  EventTemplateNotFoundError,
  InvalidEventTemplateAnswersError,
} from "./domain/exceptions/errors";

export { type EventSink } from "./domain/ports/in/event-sink";
export { type Producer } from "./domain/ports/in/producer";
export { type Registrable } from "./domain/ports/in/registrable";
export { type Registration } from "./domain/ports/in/registration";
export { type EventTemplate } from "./domain/ports/in/event-template";
export { type ListEventTemplates } from "./domain/ports/in/list-event-templates";
export { type EmitEventTemplate } from "./domain/ports/in/emit-event-template";
export { type ResolveEventTemplateFieldOptions } from "./domain/ports/in/resolve-event-template-field-options";
export { type ListProducers } from "./domain/ports/in/list-producers";
export { type ListConsumers } from "./domain/ports/in/list-consumers";
export { type SetProducerEnabled } from "./domain/ports/in/set-producer-enabled";
export { type SetConsumerEnabled } from "./domain/ports/in/set-consumer-enabled";
export { type CreateContext } from "./domain/ports/in/create-context";
export { type UpdateContext } from "./domain/ports/in/update-context";
export { type DeleteContext } from "./domain/ports/in/delete-context";
export { type ListContexts } from "./domain/ports/in/list-contexts";
export { type CreateUser } from "./domain/ports/in/create-user";
export { type DeleteUser } from "./domain/ports/in/delete-user";
export { type BeginLogin, type BeginLoginResult } from "./domain/ports/in/begin-login";
export { type CompleteLogin, type CompleteLoginResult } from "./domain/ports/in/complete-login";
export { type AuthenticateRequest } from "./domain/ports/in/authenticate-request";
export { type EmitEvent } from "./domain/ports/in/emit-event";
export { type GetPauseState } from "./domain/ports/in/get-pause-state";
export { type SetPauseState } from "./domain/ports/in/set-pause-state";
export { type ReplayEvent } from "./domain/ports/in/replay-event";
export { type AbortRun } from "./domain/ports/in/abort-run";
export { type RestartRun } from "./domain/ports/in/restart-run";
export { type GetPeakHours } from "./domain/ports/in/get-peak-hours";
export { type SetPeakHours } from "./domain/ports/in/set-peak-hours";
export { type SetConsumerWaitForOffPeak } from "./domain/ports/in/set-consumer-wait-for-off-peak";
export { type SetConsumerConfig } from "./domain/ports/in/set-consumer-config";
export { type SetConsumerSecrets } from "./domain/ports/in/set-consumer-secrets";
export { type RequestRunInput } from "./domain/ports/in/request-run-input";
export { type RecordRunUpdate } from "./domain/ports/in/record-run-update";
export { type SubmitRunInput } from "./domain/ports/in/submit-run-input";
export { type QueryLogs } from "./domain/ports/in/query-logs";

export { type Rule } from "./domain/ports/out/rule";
export { type Handler } from "./domain/ports/out/handler";
export { type EventStore } from "./domain/ports/out/event-store";
export { type RunRepository } from "./domain/ports/out/run-repository";
export { type ContextStore } from "./domain/ports/out/context-store";
export { type ContextResolver, type ContextRequester, type ContextGuard, type ResolvedContext } from "./domain/ports/out/context-resolver";
export { type ConsumerRegistry } from "./domain/ports/out/consumer-registry";
export { type ProducerRegistry, type RegisteredProducer } from "./domain/ports/out/producer-registry";
export { type EventTemplateRegistry } from "./domain/ports/out/event-template-registry";
export { type ProducerStateRepository } from "./domain/ports/out/producer-state-repository";
export { type ConsumerStateRepository } from "./domain/ports/out/consumer-state-repository";
export { type ConsumerConfigRepository } from "./domain/ports/out/consumer-config-repository";
export { type ConsumerConfigResolver } from "./domain/ports/out/consumer-config-resolver";
export { type ConsumerSecretResolver } from "./domain/ports/out/consumer-secret-resolver";
export { type PeakHoursRepository } from "./domain/ports/out/peak-hours-repository";
export { type PeakSchedule } from "./domain/ports/out/peak-schedule";
export { type IdGenerator } from "./domain/ports/out/id-generator";
export { type Clock } from "./domain/ports/out/clock";
export { type EventLifecycleObserver } from "./domain/ports/out/event-lifecycle-observer";
export { type PauseStateRepository } from "./domain/ports/out/pause-state-repository";
export { type RunAbortRegistry, type AbortHandle } from "./domain/ports/out/run-abort-registry";
export { type RunTimeoutClock, type RunTimeoutHandle } from "./domain/ports/out/run-timeout-clock";
export { type RunTimeoutResolver, DEFAULT_RUN_TIMEOUT_MS, DEFAULT_RUN_INPUT_TIMEOUT_MS } from "./domain/ports/out/run-timeout-resolver";
export { type FormRepository } from "./domain/ports/out/form-repository";
export { type RunUpdateRepository } from "./domain/ports/out/run-update-repository";
export { type RunInputRegistry, type RunInputHandle } from "./domain/ports/out/run-input-registry";
export { type CredentialStore } from "./domain/ports/out/credential-store";
export { type Logger, type LogEntry, type LogLevel, noopLogger } from "./domain/ports/out/logger";
export { type LogStore, type LogStoreQuery, type LogStoreResult } from "./domain/ports/out/log-store";
export {
  type LogContext,
  type LogContextScope,
  noopLogContextScope,
  LOG_FIELD_EVENT_ID,
  LOG_FIELD_RUN_ID,
  LOG_FIELD_CONSUMER_ID,
} from "./domain/ports/out/log-context";
export { type PasswordSecretDeriver } from "./domain/ports/out/password-secret-deriver";
export { type CredentialIssuer, type IssuedCredential } from "./domain/ports/out/credential-issuer";
export {
  type SrpHandshake,
  type SrpHandshakeBeginResult,
  type SrpHandshakeCompleteResult,
  type SrpFakeBeginResult,
} from "./domain/ports/out/srp-handshake";
export { type HandshakeStore, type StoredHandshake } from "./domain/ports/out/handshake-store";
export { type SessionStore, type SessionValue } from "./domain/ports/out/session-store";
export { type NonceCache } from "./domain/ports/out/nonce-cache";
export { type SignatureVerifier } from "./domain/ports/out/signature-verifier";
export { type SignedRequest } from "./domain/ports/out/signed-request";
export { type CanonicalRequestBuilder, type CanonicalRequestInput } from "./domain/ports/out/canonical-request";

export { type ListQuery, type ListResult } from "./domain/list";

export { SignalEventInteractor } from "./domain/interactors/signal-event-interactor";
export { RunDispatcher } from "./domain/interactors/run-dispatcher";
export { GetPauseStateInteractor } from "./domain/interactors/get-pause-state-interactor";
export { SetPauseStateInteractor } from "./domain/interactors/set-pause-state-interactor";
export { ReplayEventInteractor } from "./domain/interactors/replay-event-interactor";
export { AbortRunInteractor } from "./domain/interactors/abort-run-interactor";
export { RestartRunInteractor } from "./domain/interactors/restart-run-interactor";
export { InterruptedRunReconciler } from "./domain/interactors/interrupted-run-reconciler";
export { RequestRunInputInteractor } from "./domain/interactors/request-run-input-interactor";
export { SubmitRunInputInteractor } from "./domain/interactors/submit-run-input-interactor";
export {
  RecordRunUpdateInteractor,
  InvalidRunUpdateMessageError,
  MAX_RUN_UPDATE_MESSAGE_BYTES,
} from "./domain/interactors/record-run-update-interactor";
export { ListProducersInteractor } from "./domain/interactors/list-producers-interactor";
export { ListConsumersInteractor } from "./domain/interactors/list-consumers-interactor";
export { ListEventTemplatesInteractor } from "./domain/interactors/list-event-templates-interactor";
export { EmitEventTemplateInteractor } from "./domain/interactors/emit-event-template-interactor";
export { ResolveEventTemplateFieldOptionsInteractor } from "./domain/interactors/resolve-event-template-field-options-interactor";
export { SetProducerEnabledInteractor } from "./domain/interactors/set-producer-enabled-interactor";
export { SetConsumerEnabledInteractor } from "./domain/interactors/set-consumer-enabled-interactor";
export { CreateContextInteractor } from "./domain/interactors/create-context-interactor";
export { UpdateContextInteractor } from "./domain/interactors/update-context-interactor";
export { DeleteContextInteractor } from "./domain/interactors/delete-context-interactor";
export { ListContextsInteractor } from "./domain/interactors/list-contexts-interactor";
export { CreateUserInteractor } from "./domain/interactors/create-user-interactor";
export { DeleteUserInteractor } from "./domain/interactors/delete-user-interactor";
export { BeginLoginInteractor } from "./domain/interactors/begin-login-interactor";
export { CompleteLoginInteractor } from "./domain/interactors/complete-login-interactor";
export { AuthenticateRequestInteractor } from "./domain/interactors/authenticate-request-interactor";
export { EmitEventInteractor } from "./domain/interactors/emit-event-interactor";
export { GetPeakHoursInteractor } from "./domain/interactors/get-peak-hours-interactor";
export { SetPeakHoursInteractor } from "./domain/interactors/set-peak-hours-interactor";
export { SetConsumerConfigInteractor } from "./domain/interactors/set-consumer-config-interactor";
export { SetConsumerSecretsInteractor } from "./domain/interactors/set-consumer-secrets-interactor";
export { SetConsumerWaitForOffPeakInteractor } from "./domain/interactors/set-consumer-wait-for-off-peak-interactor";
export { ConsumerDescriptorBuilder } from "./domain/interactors/consumer-descriptor-builder";
export { QueryLogsInteractor } from "./domain/interactors/query-logs-interactor";

export { App } from "./infra/main/app";
export { MakeApp, type AppConfig, type ApiConfig } from "./infra/main/make-app";
export { type AuthConfig, defaultAuthConfig, DEFAULT_HANDSHAKE_TTL_MS, DEFAULT_SESSION_LIFETIME_MS, DEFAULT_FRESHNESS_WINDOW_MS } from "./infra/main/auth-config";
export { RegistrationContext } from "./infra/main/registration-context";
export { type Closeable } from "./infra/main/closeable";
export { type Startable } from "./infra/main/startable";

export { InMemoryEventStore } from "./infra/adapters/stores/in-memory-event-store";
export { InMemoryRunRepository } from "./infra/adapters/stores/in-memory-run-repository";
export { InMemoryProducerStateRepository } from "./infra/adapters/stores/in-memory-producer-state-repository";
export { InMemoryConsumerStateRepository } from "./infra/adapters/stores/in-memory-consumer-state-repository";
export { InMemoryContextStore } from "./infra/adapters/stores/in-memory-context-store";
export { InMemoryCredentialStore } from "./infra/adapters/stores/in-memory-credential-store";
export { InMemoryPauseStateRepository } from "./infra/adapters/stores/in-memory-pause-state-repository";
export { InMemoryConsumerConfigRepository } from "./infra/adapters/stores/in-memory-consumer-config-repository";
export { InMemoryPeakHoursRepository } from "./infra/adapters/stores/in-memory-peak-hours-repository";
export { InMemoryFormRepository } from "./infra/adapters/stores/in-memory-form-repository";
export { InMemoryRunUpdateRepository } from "./infra/adapters/stores/in-memory-run-update-repository";
export { InMemoryLogStore } from "./infra/adapters/stores/in-memory-log-store";
export { InMemoryRunAbortRegistry } from "./infra/adapters/registry/in-memory-run-abort-registry";
export { InMemoryRunInputRegistry } from "./infra/adapters/registry/in-memory-run-input-registry";
export { InMemoryRunTimeoutClock } from "./infra/adapters/registry/in-memory-run-timeout-clock";
export { REPLAY_PRODUCER_ID } from "./infra/adapters/replay/replay-producer-id";
export {
  CONCORD_RUN_INPUT_PRODUCER_ID,
  RUN_INPUT_REQUESTED,
  type RunInputRequestedPayload,
  type RunInputEventEmitter,
} from "./domain/events/run-input-event";
export { SqliteDatabase } from "./infra/adapters/stores/sqlite/sqlite-database";
export { SqliteEventStore } from "./infra/adapters/stores/sqlite/sqlite-event-store";
export { SqliteRunRepository } from "./infra/adapters/stores/sqlite/sqlite-run-repository";
export { SqliteProducerStateRepository } from "./infra/adapters/stores/sqlite/sqlite-producer-state-repository";
export { SqliteConsumerStateRepository } from "./infra/adapters/stores/sqlite/sqlite-consumer-state-repository";
export { SqliteContextStore } from "./infra/adapters/stores/sqlite/sqlite-context-store";
export { SqliteCredentialStore } from "./infra/adapters/stores/sqlite/sqlite-credential-store";
export { SqlitePauseStateRepository } from "./infra/adapters/stores/sqlite/sqlite-pause-state-repository";
export { SqliteConsumerConfigRepository } from "./infra/adapters/stores/sqlite/sqlite-consumer-config-repository";
export { SqlitePeakHoursRepository, PEAK_HOURS_ROW_ID } from "./infra/adapters/stores/sqlite/sqlite-peak-hours-repository";
export { SqliteFormRepository } from "./infra/adapters/stores/sqlite/sqlite-form-repository";
export { SqliteRunUpdateRepository } from "./infra/adapters/stores/sqlite/sqlite-run-update-repository";
export { SqliteLogStore } from "./infra/adapters/stores/sqlite/sqlite-log-store";
export { SqliteSessionStore } from "./infra/adapters/stores/sqlite/sqlite-session-store";
export { SqlitePullRequestLifecycleStore } from "./infra/adapters/stores/sqlite/sqlite-pull-request-lifecycle-store";
export {
  SqlitePersistenceFactory,
  type SqlitePersistenceBundle,
} from "./infra/adapters/stores/sqlite/sqlite-persistence-factory";
export { EventV1 } from "./infra/adapters/stores/sqlite/dto/event-v1";
export { RunV1 } from "./infra/adapters/stores/sqlite/dto/run-v1";
export { ProducerStateV1 } from "./infra/adapters/stores/sqlite/dto/producer-state-v1";
export { ConsumerStateV1 } from "./infra/adapters/stores/sqlite/dto/consumer-state-v1";
export { ContextV1 } from "./infra/adapters/stores/sqlite/dto/context-v1";
export { CredentialV1 } from "./infra/adapters/stores/sqlite/dto/credential-v1";
export { PauseStateV1 } from "./infra/adapters/stores/sqlite/dto/pause-state-v1";
export { ConsumerConfigV1 } from "./infra/adapters/stores/sqlite/dto/consumer-config-v1";
export { PeakHoursV1 } from "./infra/adapters/stores/sqlite/dto/peak-hours-v1";
export { FormV1 } from "./infra/adapters/stores/sqlite/dto/form-v1";
export { RunUpdateV1 } from "./infra/adapters/stores/sqlite/dto/run-update-v1";
export { LogV1 } from "./infra/adapters/stores/sqlite/dto/log-v1";
export { SessionV1 } from "./infra/adapters/stores/sqlite/dto/session-v1";
export { EventEmittingContextResolver, ERROR_CONTEXT, CONCORD_PRODUCER_ID } from "./infra/adapters/context/event-emitting-context-resolver";
export { InMemoryConsumerRegistry } from "./infra/adapters/registry/in-memory-consumer-registry";
export { InMemoryProducerRegistry } from "./infra/adapters/registry/in-memory-producer-registry";
export { UuidIdGenerator } from "./infra/adapters/system/uuid-id-generator";
export { SystemClock } from "./infra/adapters/system/system-clock";
export { StructuredLogger } from "./infra/adapters/system/structured-logger";
export { AsyncLogContextScope } from "./infra/adapters/system/async-log-context-scope";

export {
  WebSocketProducer,
  RAWJSON,
  type WebSocketProducerAddress,
} from "./infra/adapters/producers/websocket/websocket-producer";
export { GithubPrProducer } from "./infra/adapters/producers/github/github-producer";
export {
  PullRequest,
  PR_OPENED,
  PR_MERGE_CONFLICTS,
  PR_TESTS_FAILED,
  PR_TESTS_SUCCEEDED,
  PR_VALIDATION_FAILED,
  PR_VALIDATION_SUCCEEDED,
  PR_MERGED,
  PR_MISSING,
  type PrEventPayload,
  type PrOpenedPayload,
  type PrMergeConflictsPayload,
  type PrTestsSucceededPayload,
  type PrTestsFailedPayload,
  type PrValidationSucceededPayload,
  type PrValidationFailedPayload,
  type PrMergedPayload,
  type PrMissingPayload,
  type CheckRunSummary,
  type RepoRefDto,
} from "./infra/adapters/producers/github/pull-request";
export { CheckRun } from "./infra/adapters/producers/github/check-run";
export { CheckSuite } from "./infra/adapters/producers/github/check-suite";
export { GithubIssue } from "./infra/adapters/producers/github/github-issue";
export { fetchAuthoritativeMergeableState } from "./infra/adapters/producers/github/mergeable-state";
export {
  type GitHubClient,
  type RepoRef,
  type IssueComment,
  type MergeMethod,
  type ReviewEvent,
  parseRepoRef,
} from "./infra/adapters/producers/github/github-client";
export {
  GITHUB_REPOS_CONTEXT,
  type GithubRepoEntry,
  type GithubReposContextPayload,
  isGithubReposContextPayload,
} from "./infra/adapters/producers/github/github-repos-context";
export {
  type PullRequestLifecycleStore,
  type PrLifecycleState,
  type StoredLifecycleEntry,
} from "./infra/adapters/producers/github/pull-request-lifecycle-store";
export { InMemoryPullRequestLifecycleStore } from "./infra/adapters/producers/github/in-memory-pull-request-lifecycle-store";
export {
  type GithubCredentials,
  type GithubCredentialsProvider,
} from "./infra/adapters/producers/github/github-credentials";
export { GhCliCredentialsProvider } from "./infra/adapters/producers/github/gh-cli-credentials";
export { OctokitGitHubClient } from "./infra/adapters/producers/github/octokit-github-client";
export {
  GithubPrProducerFactory,
  DEFAULT_POLL_INTERVAL_MS,
} from "./infra/adapters/producers/github/make-github-producer";
export { InlineProducer } from "./infra/adapters/producers/inline/inline-producer";
export { StdioConsumer } from "./infra/adapters/consumers/stdio/stdio-consumer";
export { StdioRule } from "./infra/adapters/consumers/stdio/stdio-rule";
export { StdioHandler } from "./infra/adapters/consumers/stdio/stdio-handler";
export { ConsumerRegistrable } from "./infra/adapters/consumers/consumer-registrable";

export { type WorktreeManager, type SafeWorktreeRemovalOutcome } from "./domain/ports/out/worktree-manager";
export { type OpencodeRunner, type OpencodeRunnerOptions } from "./domain/ports/out/opencode-runner";
export { GitWorktreeManager } from "./infra/adapters/git/git-worktree-manager";
export { type RunCompletionHook, type FinishedRun, type TerminalRunState, NoOpRunCompletionHook } from "./domain/ports/out/run-completion-hook";
export { WorktreeLeaseRegistry, type WorktreeLeases, DEFAULT_FAILED_WORKTREE_HOLD_MS } from "./infra/adapters/git/worktree-lease-registry";
export { WorktreeGarbageCollector, DEFAULT_WORKTREE_GC_MAX_AGE_MS, type WorktreeGcSummary } from "./infra/adapters/git/worktree-garbage-collector";
export {
  OpencodeSdkRunner,
  type OpencodeServerSpawner,
  type OpencodeClientFactory,
  type OpencodePromptClient,
  type OpencodeServerHandle,
  type OpencodeRunInputWiring,
  type OpencodeEvent,
  type OpencodeEventSubscription,
} from "./infra/adapters/opencode/opencode-sdk-runner";
export {
  type RunActivityEmitter,
  type RunActivityFrame,
  NoOpRunActivityEmitter,
} from "./infra/adapters/opencode/run-activity-emitter";
export {
  RunInputMcpServer,
  TOOL_NAME as ASK_QUESTION_TOOL_NAME,
  RUN_TOOLS_MCP_SERVER_NAME,
  type RunInputMcpServerOptions,
  type RunMcpBackend,
  type RunMcpBackendFactory,
  type RunInputMcpBackend,
  type RunInputMcpBackendFactory,
  type StartedRunInputMcpServer,
  type AskQuestionToolResult,
} from "./infra/adapters/opencode/run-input-mcp-server";
export { RealRunMcpBackendFactory } from "./infra/adapters/opencode/real-run-input-mcp-backend";
export {
  RunUpdateMcpServer,
  POST_UPDATE_TOOL_NAME,
  type RunUpdateMcpServerOptions,
  type StartedRunUpdateMcpServer,
} from "./infra/adapters/opencode/run-update-mcp-server";
export {
  PathBinaryResolver,
  type BinaryResolver,
  BinaryNotFoundError,
  robustSpawnEnv,
} from "./infra/adapters/system/binary-resolver";
export { MergingConsumerConfigResolver } from "./infra/adapters/config/merging-consumer-config-resolver";
export { ConfigRunTimeoutResolver, RUN_TIMEOUT_MS_KEY } from "./infra/adapters/config/config-run-timeout-resolver";
export { RepositoryConsumerSecretResolver } from "./infra/adapters/config/repository-consumer-secret-resolver";
export { IntlPeakSchedule } from "./infra/adapters/scheduling/intl-peak-schedule";
export { OffPeakScheduler, type SchedulerTimer } from "./infra/adapters/scheduling/off-peak-scheduler";

export { AGENT_CONSUMER_CONFIG_SCHEMA, AGENT_GITHUB_TOKEN_SECRET } from "./infra/adapters/consumers/agents/agent-config-schema";
export { ConsumerGitHubClientResolver, type ResolvedGitHubIdentity } from "./infra/adapters/consumers/agents/consumer-github-client-resolver";
export { JobStartedNotifier, type JobStartedNotification } from "./infra/adapters/consumers/agents/job-started-notifier";
export { OctokitGitHubClientFactory, type GitHubClientFactory } from "./infra/adapters/producers/github/github-client-factory";
export { RepoEntryLookup } from "./infra/adapters/consumers/agents/repo-entry-lookup";
export { findProducedPullRequest, type FindProducedPullRequestDeps, type FindProducedPullRequestInput } from "./infra/adapters/consumers/agents/find-produced-pr";
export { prMissingEventId } from "./infra/adapters/consumers/agents/pr-missing-event-id";
export { runPrCodeProducing, type PrCodeProducingRequest, type PrCodeProducingOutcome } from "./infra/adapters/consumers/agents/pr-code-producing";
export {
  AgentTaskRunner,
  type BranchSpecification,
  type CodeProducingRequest,
  type CodeProducingResult,
  type ReviewRequest,
  type ReviewResult,
} from "./infra/adapters/consumers/agents/agent-task-runner";

export {
  TelegramNotifierConsumer,
} from "./infra/adapters/consumers/telegram/telegram-notifier-consumer";
export { TelegramNotifierRule } from "./infra/adapters/consumers/telegram/telegram-notifier-rule";
export { TelegramNotifierHandler } from "./infra/adapters/consumers/telegram/telegram-notifier-handler";
export {
  TelegramBotClient,
  type TelegramClient,
  type SendMessageRequest,
} from "./infra/adapters/consumers/telegram/telegram-client";
export {
  TELEGRAM_NOTIFIER_CONSUMER_ID,
  TELEGRAM_NOTIFIER_CONFIG_SCHEMA,
  TELEGRAM_NOTIFIER_SECRET,
} from "./infra/adapters/consumers/telegram/telegram-config-schema";

export { NoOpEventLifecycleObserver } from "./infra/adapters/api/no-op-event-lifecycle-observer";
export { CompositeEventLifecycleObserver } from "./infra/adapters/api/composite-event-lifecycle-observer";
export { StreamBroadcaster } from "./infra/adapters/api/stream-broadcaster";
export {
  HttpApiServer,
  type HttpApiServerAddress,
} from "./infra/adapters/api/http-api-server";
export { InMemoryEventTemplateRegistry } from "./infra/adapters/registry/in-memory-event-template-registry";
export {
  type Widget,
  type WidgetPayload,
  type WidgetDescriptor,
  type WidgetRefresh,
} from "./infra/adapters/widgets/widget";
export {
  STATUS_PANEL_KIND,
  type StatusPanelPayload,
  type StatusPanelItem,
  type StatusPanelItemStatus,
  type StatusPanelState,
} from "./infra/adapters/widgets/status-panel";
export {
  type WidgetRegistry,
  InMemoryWidgetRegistry,
} from "./infra/adapters/widgets/widget-registry";
export { WidgetNotFoundError } from "./infra/adapters/widgets/widget-not-found-error";
export { RawJsonEventTemplate } from "./infra/adapters/event-templates/raw-json-event-template";
export { EventTemplateRegistrable } from "./infra/adapters/event-templates/event-template-registrable";
export {
  type EventDto,
  type RunDto,
  type RunFailureDto,
  type ProducerDto,
  type ConsumerDto,
  type ConsumerConfigParameterDto,
  type ConsumerConfigSecretParameterDto,
  type ConsumerConfigValuesDto,
  type ContextDto,
  type PeakHoursDto,
  type FieldDefinitionDto,
  type AnswerValueDto,
  type AnswerMapDto,
  type RunFormDto,
  type RunUpdateDto,
  type EventTemplateDto,
  type FieldOptionDto,
  type LogEntryDto,
  type WidgetDescriptorDto,
  type WidgetRefreshDto,
  type ApiSuccessEnvelope,
  type ApiErrorBody,
  type ApiErrorEnvelope,
  type ApiEnvelope,
  ERROR_BAD_REQUEST,
  ERROR_NOT_FOUND,
  ERROR_FORBIDDEN,
  ERROR_INTERNAL,
  ERROR_CONFLICT,
  ERROR_UNAUTHORIZED,
  toEventDto,
  toRunDto,
  toRunFailureDto,
  toProducerDto,
  toConsumerDto,
  toContextDto,
  toPeakHoursDto,
  toFieldDefinitionDto,
  toRunFormDto,
  toRunUpdateDto,
  toEventTemplateDto,
  toLogEntryDto,
  toWidgetDescriptorDto,
  successEnvelope,
  errorEnvelope,
} from "./infra/adapters/api/api-dtos";

export {
  Argon2PasswordSecretDeriver,
  type Argon2Parameters,
  OWASP_ARGON2ID_PARAMETERS,
  TEST_ARGON2ID_PARAMETERS,
} from "./infra/adapters/auth/argon2-password-secret-deriver";
export { SecureRemotePasswordIssuer } from "./infra/adapters/auth/secure-remote-password-issuer";
export { SecureRemotePasswordHandshake } from "./infra/adapters/auth/secure-remote-password-handshake";
export { NodeHmacSignatureVerifier } from "./infra/adapters/auth/node-hmac-signature-verifier";
export { InMemoryHandshakeStore } from "./infra/adapters/auth/in-memory-handshake-store";
export { InMemorySessionStore } from "./infra/adapters/auth/in-memory-session-store";
export { InMemoryNonceCache } from "./infra/adapters/auth/in-memory-nonce-cache";
export { CanonicalRequest } from "./infra/adapters/auth/canonical-request";

export {
  startServer,
  resolveServerConfig,
  defaultUiDir,
  type ServerConfig,
  type ServerHandle,
  type StartServerOptions,
  type Composition,
  type CompositionContributions,
} from "./server/start-server";

export { parseArgv, ArgvParseError, type ParsedArgs } from "./cli/args/argv-parser";
export {
  runCli,
  type CommandHandler,
  type CommandHandlers,
} from "./cli/main/run-cli";
export {
  builtinCommandHandlers,
  runCommand,
  requireFlag,
} from "./cli/main/run-command";
export { resolveDatabasePath } from "./cli/main/compose";
export { CLI_PRODUCER_ID } from "./cli/commands/event-emit-command";
export {
  buildLocalDeps,
  closeLocalDeps,
  type LocalDeps,
} from "./cli/main/local-compose";
