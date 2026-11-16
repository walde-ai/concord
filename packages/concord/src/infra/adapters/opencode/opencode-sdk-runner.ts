import { spawn, type ChildProcess } from "child_process";
import { createServer } from "net";
import { randomBytes } from "node:crypto";
import { stat } from "node:fs/promises";

import type { Logger } from "../../../domain/ports/out/logger";
import { noopLogger } from "../../../domain/ports/out/logger";
import type { OpencodeRunner, OpencodeRunnerOptions } from "../../../domain/ports/out/opencode-runner";
import { DEFAULT_RUN_INPUT_TIMEOUT_MS } from "../../../domain/ports/out/run-timeout-resolver";
import type { RequestRunInput } from "../../../domain/ports/in/request-run-input";
import type { RecordRunUpdate } from "../../../domain/ports/in/record-run-update";
import type { RunMcpBackend, RunMcpBackendFactory } from "./run-input-mcp-server";
import { RunInputMcpServer, RUN_TOOLS_MCP_SERVER_NAME } from "./run-input-mcp-server";
import { RunUpdateMcpServer } from "./run-update-mcp-server";
import type { RunActivityEmitter } from "./run-activity-emitter";
import { NoOpRunActivityEmitter } from "./run-activity-emitter";
import {
  SessionStallWatchdog,
  ToolStreamStalledError,
  ModelStreamStalledError,
  type StallAbortTarget,
} from "./session-stall-watchdog";
import { UnexpectedStateError, WorktreeVanishedError } from "../../../domain/exceptions/errors";
import {
  PathBinaryResolver,
  robustSpawnEnv,
  type BinaryResolver,
} from "../system/binary-resolver";

const HOST = "127.0.0.1";
const HEALTH_TIMEOUT_MS = 10_000;
const HEALTH_POLL_INTERVAL_MS = 100;
const SPAWN_ATTEMPTS = 3;
const OUTPUT_LIMIT = 4096;
const HEALTH_BODY_LIMIT = 200;
// Per-request cap. opencode binds its TCP socket before its HTTP handler is
// ready, so a bare `fetch` against the not-yet-ready handler hangs forever and
// the HEALTH_TIMEOUT_MS deadline is never re-checked. Bounding each probe keeps
// the polling loop making progress; a ready /health responds in milliseconds.
const PROBE_TIMEOUT_MS = 2_000;

// A freshly spawned opencode server binds its TCP socket before its HTTP
// /health handler is ready, so the first ~1-2s of probes routinely fail on an
// otherwise-healthy spawn. The readiness warning must not cry wolf on that
// normal startup. opencode reliably registers the handler well within the
// HEALTH_TIMEOUT_MS budget, so tie the warning to elapsed readiness time
// instead of a fixed probe count: stay silent while failed probes consume less
// than HEALTH_WARN_DEADLINE_FRACTION of the budget, and warn once past it — at
// that point a true readiness failure is imminent. The previous fixed-count
// threshold (5 probes / 500ms) fired on ~180 of ~190 healthy spawns with zero
// real spawn failures, masking the signal entirely. The terminal "did not
// become healthy" error thrown at HEALTH_TIMEOUT_MS remains the source of truth
// for an actual failure.
export const HEALTH_WARN_DEADLINE_FRACTION = 0.5;
export const HEALTH_WARN_AFTER_MS = Math.round(HEALTH_TIMEOUT_MS * HEALTH_WARN_DEADLINE_FRACTION);

// When the model API (or the opencode server itself) is unreachable, the prompt
// request fails with a transient error. Rather than failing the run outright we
// retry with exponential backoff, bounded by the run's AbortSignal (the
// per-consumer run timeout). The first backoff is short so a momentary blip
// recovers instantly; the cap keeps us from hammering a long outage while still
// waking up promptly once connectivity returns.
const PROMPT_RETRY_INITIAL_DELAY_MS = 2_000;
const PROMPT_RETRY_MAX_DELAY_MS = 60_000;
const PROMPT_RETRY_BACKOFF_MULTIPLIER = 2;
// How many times promptWithStructuredOutputNudges re-prompts the session after
// the agent ends a turn without the required JSON object. OpenCode 2.x marks a
// session idle the moment the agent ends its turn, but an agent may end a turn
// mid-task on purpose ("the integration suite is running in the background;
// I'll resume when it finishes") because it wrongly assumes an external driver
// will wake it. Nothing does: the follow-up prompt is that driver. Each nudge
// tells the agent to continue inside a single turn and deliver the JSON;
// the budget bounds a model that keeps ending turns, and the run's own
// AbortSignal bounds the total time.
export const MAX_STRUCTURED_OUTPUT_NUDGES = 5;
// How many times createSessionWithRetry re-issues POST /api/session after the
// freshly spawned opencode server answers HTTP 503 {"code":"service_starting"}.
// opencode 2.x reports /health as OK while its internal services are still
// initializing, so the first API call can lose that race (observed in
// production on a resource-constrained host with concurrent spawns):
// run 84151ec1 on the Walde RPI failed terminally with
// `opencode POST /api/session failed (HTTP 503): {"code":"service_starting"}`
// before any prompt was sent. The refusal carries no side effects — no session
// was created — so retrying is safe; short fixed delays cover an init that
// routinely completes in well under a second on a healthy host.
export const MAX_SESSION_CREATE_ATTEMPTS = 6;
export const SESSION_CREATE_RETRY_DELAY_MS = 1_000;
// Body of the follow-up prompt; the output contract (schema block) is appended
// by withStructuredOutputInstruction so the required format stays in context.
const STRUCTURED_OUTPUT_NUDGE_BODY = [
  "You ended your turn without the required final JSON output.",
  "This session has no external driver: nobody will wake you when background work finishes, so ending the turn again cannot make progress.",
  "Continue the task now, inside this turn.",
  "If you started a long-running command (test suite, build), wait for it within this turn — for example by polling it from the shell — before you answer.",
  "Do not end your turn again until the task is complete.",
].join("\n");

export type PortAllocator = () => number | Promise<number>;

export interface OpencodeServerHandle {
  readonly port: number;
  kill(): void;
  // Accumulated stdout/stderr and exit reason of the spawned opencode process.
  // Returns an empty string when the handle has no attached process (fakes).
  diagnostics(): string;
}

export interface OpencodeServerSpawner {
  spawn(cwd: string, port: number, env?: Record<string, string>): Promise<OpencodeServerHandle>;
}

export interface OpencodePromptClient {
  createSession(directory: string, options: OpencodeRunnerOptions): Promise<string>;
  prompt(sessionId: string, promptText: string, options: OpencodeRunnerOptions, schema?: object, signal?: AbortSignal): Promise<unknown>;
  // Best-effort stop of a session's in-flight execution (used to unblock a
  // wedged generation before re-sending a prompt after a model-stall abort).
  interrupt(sessionId: string): Promise<void>;
  subscribeEvents(directory: string): Promise<OpencodeEventSubscription>;
}

export interface OpencodeEvent {
  readonly type: string;
  readonly properties: Record<string, unknown>;
}

export interface OpencodeEventSubscription {
  readonly events: AsyncGenerator<OpencodeEvent>;
  close(): void;
}

export interface OpencodeClientFactory {
  create(baseUrl: string, auth: OpencodeServerAuth): Promise<OpencodePromptClient>;
}

// OpenCode 2.x servers require HTTP Basic auth on every API route. The runner
// owns the spawned process, so it pins the server password through the
// OPENCODE_SERVER_PASSWORD env var and hands the same secret to the client
// factory.
// Without it, `opencode serve` generates a random password printed to stdout
// that no API request could authenticate with.
export interface OpencodeServerAuth {
  readonly password: string;
}

async function assertSpawnDirectoryExists(directory: string): Promise<void> {
  try {
    const stats = await stat(directory);
    if (stats.isDirectory()) {
      return;
    }
  } catch {
    // fall through to the vanished-worktree error below
  }
  throw new WorktreeVanishedError(directory);
}

export class ChildProcessOpencodeSpawner implements OpencodeServerSpawner {
  public constructor(
    private readonly resolver: BinaryResolver = new PathBinaryResolver(),
    private readonly logger: Logger = noopLogger,
  ) {}

  public async spawn(cwd: string, port: number, env?: Record<string, string>): Promise<OpencodeServerHandle> {
    // concord#24: the spawn cwd can vanish between worktree acquisition and
    // spawn (a cleanup race). Fail with the named error instead of an
    // opaque ENOENT from the health loop.
    await assertSpawnDirectoryExists(cwd);
    const opencode = await this.resolver.resolve("opencode");
    const baseEnv = robustSpawnEnv();
    const child = spawn(opencode, ["serve", "--hostname", HOST, "--port", String(port)], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: env === undefined ? baseEnv : { ...baseEnv, ...env },
    });
    const log = new ServerProcessLog(child);
    const isDead = (): boolean => child.exitCode !== null || child.signalCode !== null;
    try {
      await waitForHealth(port, isDead, this.logger);
    } catch (cause) {
      if (!isDead()) {
        child.kill("SIGTERM");
      }
      const diagnostic = log.summary();
      const base = cause instanceof Error ? cause.message : "health check failed";
      throw new UnexpectedStateError(diagnostic.length > 0 ? `${base}: ${diagnostic}` : base);
    }
    return {
      port,
      kill() {
        child.kill("SIGTERM");
      },
      diagnostics: () => log.summary(),
    };
  }
}

// undici is ESM-only while this package compiles to CommonJS, so it cannot be
// statically required. The dynamic import is built via `new Function` so the
// CJS compiler does not down-level it back into a require() call.
type UndiciModule = typeof import("undici");
const importUndici = new Function(
  "specifier",
  "return import(specifier)",
) as (specifier: string) => Promise<UndiciModule>;

// A single prompt→wait cycle stays open for the entire agent run, which
// routinely exceeds undici's default 300s headers/body timeout and is aborted
// mid-run (UND_ERR_HEADERS_TIMEOUT, surfacing as a bare "fetch failed" at ~5
// minutes while the opencode process is still alive). Back every request with
// an Agent from the same undici package that provides the fetch — mixing the
// npm Agent into the *global* fetch breaks on newer Node versions (the bundled
// undici rejects foreign dispatchers with "invalid onError method"), so both
// come from the engine's own dependency and are version-matched by design.
// The run's AbortSignal still bounds each request's lifetime.
//
// The structural response type keeps undici's class identities out of the
// public surface: only the members the client reads are declared.
type LongLivedResponse = {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
  readonly body: ReadableStream<Uint8Array> | null;
};

type LongLivedRequest = {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | undefined;
  readonly signal: AbortSignal | undefined;
};

type LongLivedFetch = (request: LongLivedRequest) => Promise<LongLivedResponse>;

function createLongLivedFetch(): Promise<LongLivedFetch> {
  return importUndici("undici").then((undici) => {
    const dispatcher = new undici.Agent({ headersTimeout: 0, bodyTimeout: 0 });
    return (request) =>
      undici.fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal: request.signal,
        dispatcher,
      }) as Promise<LongLivedResponse>;
  });
}

// OpenCode 2.x authenticates every API route with HTTP Basic auth; the username
// is always "opencode" and the password is whatever OPENCODE_SERVER_PASSWORD
// pinned on
// the spawned server (see the migration guide's "Server authentication").
const V2_AUTH_USERNAME = "opencode";

// Reconnect cadence for the SSE event subscription after a dropped connection.
// The V2 event stream is live-only with no replay: reconnect promptly so the
// stall watchdog and the UI activity stream keep working through undici's idle
// disconnects, while backing off so a dead server is not hammered.
const SSE_RECONNECT_INITIAL_DELAY_MS = 1_000;
const SSE_RECONNECT_MAX_DELAY_MS = 30_000;

export class HttpApiV2OpencodeClientFactory implements OpencodeClientFactory {
  private fetchPromise: Promise<LongLivedFetch> | null = null;

  public async create(baseUrl: string, auth: OpencodeServerAuth): Promise<OpencodePromptClient> {
    const fetchFn = await this.longLivedFetch();
    const authorization = `Basic ${Buffer.from(`${V2_AUTH_USERNAME}:${auth.password}`, "utf8").toString("base64")}`;
    const api = new V2HttpApi(baseUrl, authorization, fetchFn);
    return {
      createSession: (directory, options) => api.createSession(directory, options),
      prompt: (sessionId, promptText, options, schema, signal) => api.prompt(sessionId, promptText, schema, signal),
      interrupt: (sessionId) => api.interrupt(sessionId),
      subscribeEvents: (directory) => api.subscribeEvents(directory),
    };
  }

  private longLivedFetch(): Promise<LongLivedFetch> {
    if (this.fetchPromise === null) {
      this.fetchPromise = createLongLivedFetch();
    }
    return this.fetchPromise;
  }
}

// Thin client for the OpenCode 2.x HTTP API
// (https://opencode.ai/docs/api). The endpoints the runner drives:
//   POST /api/session                                   — create (agent + model + location)
//   POST /api/session/{id}/prompt                       — enqueue the user message
//   POST /api/experimental/session/{id}/wait            — block until the session is idle
//   GET  /api/session/{id}/message                      — newest-first message list
//   POST /api/session/{id}/interrupt                    — stop in-flight execution
//   GET  /api/event                                     — SSE event stream
// The V1 SDK (and its blocking session.prompt + native json_schema OutputFormat)
// no longer exists in 2.x: agent and model move to session creation, the prompt
// body is plain text, and structured output is requested through the prompt
// text and parsed from the final assistant message.
class V2HttpApi {
  public constructor(
    private readonly baseUrl: string,
    private readonly authorization: string,
    private readonly fetchFn: LongLivedFetch,
  ) {}

  public async createSession(directory: string, options: OpencodeRunnerOptions): Promise<string> {
    const body = buildSessionCreateBody(directory, options);
    const payload = await this.request("POST", "/api/session", body, undefined);
    const data = (payload as { data?: { id?: unknown } }).data;
    if (typeof data?.id !== "string" || data.id.length === 0) {
      throw new UnexpectedStateError(`Opencode POST /api/session returned no session id: ${describeJson(payload)}`);
    }
    return data.id;
  }

  public async prompt(
    sessionId: string,
    promptText: string,
    schema: object | undefined,
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    // OpenCode 2.x has no native structured output: the schema travels as an
    // explicit output contract in the prompt text and the JSON object is
    // parsed out of the final assistant message (see extractStructuredOutput).
    const sendTurn = async (turnPrompt: string): Promise<unknown> => {
      await this.request("POST", `/api/session/${sessionId}/prompt`, { text: turnPrompt }, signal);
      await this.request("POST", `/api/experimental/session/${sessionId}/wait`, undefined, signal);
      const payload = await this.request("GET", `/api/session/${sessionId}/message`, undefined, signal);
      return (payload as { data?: unknown }).data;
    };
    if (schema === undefined) {
      return extractPromptResult(await sendTurn(promptText), false);
    }
    return promptWithStructuredOutputNudges({
      promptText,
      schema,
      sendTurn,
      maxNudges: MAX_STRUCTURED_OUTPUT_NUDGES,
    });
  }

  public async interrupt(sessionId: string): Promise<void> {
    await this.request("POST", `/api/session/${sessionId}/interrupt`, undefined, undefined);
  }

  public async subscribeEvents(directory: string): Promise<OpencodeEventSubscription> {
    const controller = new AbortController();
    const api = this;
    async function* stream(): AsyncGenerator<OpencodeEvent> {
      let reconnectDelayMs = SSE_RECONNECT_INITIAL_DELAY_MS;
      while (!controller.signal.aborted) {
        let connected = false;
        try {
          const response = await api.fetchFn({
            url: `${api.baseUrl}/api/event`,
            method: "GET",
            headers: { authorization: api.authorization, accept: "text/event-stream" },
            body: undefined,
            signal: controller.signal,
          });
          if (!response.ok || response.body === null) {
            throw new UnexpectedStateError(`event stream HTTP ${response.status}`);
          }
          connected = true;
          for await (const frame of readSseFrames(response.body)) {
            const event = parseSseFrame(frame);
            if (event !== undefined) {
              yield event;
            }
          }
        } catch {
          // A dropped or failed stream reconnects below unless close() raced it.
        }
        if (controller.signal.aborted) {
          return;
        }
        if (connected) {
          reconnectDelayMs = SSE_RECONNECT_INITIAL_DELAY_MS;
        }
        await abortableDelay(reconnectDelayMs, controller.signal);
        reconnectDelayMs = Math.min(reconnectDelayMs * 2, SSE_RECONNECT_MAX_DELAY_MS);
      }
    }
    return {
      events: stream(),
      close: () => {
        controller.abort();
      },
    };
  }

  private async request(method: string, path: string, body: object | undefined, signal: AbortSignal | undefined): Promise<unknown> {
    const response = await this.fetchFn({
      url: `${this.baseUrl}${path}`,
      method,
      headers: {
        authorization: this.authorization,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      throw new UnexpectedStateError(`opencode ${method} ${path} failed (HTTP ${response.status}): ${await describeResponseBody(response)}`);
    }
    if (response.status === 204) {
      return {};
    }
    return await response.json();
  }
}

// Reads a text/event-stream body and yields each complete frame's data lines
// joined with "\n" (per the SSE spec). Comment lines (": heartbeat") produce
// no frame. Splitting on line boundaries handles chunk boundaries of any size.
async function* readSseFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dataLines: string[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
        buffer = buffer.slice(newlineIndex + 1);
        if (line.length === 0) {
          if (dataLines.length > 0) {
            yield dataLines.join("\n");
            dataLines = [];
          }
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice("data:".length).replace(/^ /, ""));
        }
        newlineIndex = buffer.indexOf("\n");
      }
    }
    if (dataLines.length > 0) {
      yield dataLines.join("\n");
    }
  } finally {
    reader.releaseLock();
  }
}

// Each SSE frame carries one JSON-encoded event:
//   {"id":"evt_...","type":"session.tool.called","location":{...},"data":{...}}
// Map it onto the runner's OpencodeEvent shape: type from the envelope,
// properties from the nested data object.
export function parseSseFrame(frame: string): OpencodeEvent | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(frame);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const candidate = parsed as { type?: unknown; data?: unknown };
  if (typeof candidate.type !== "string") {
    return undefined;
  }
  const properties = candidate.data;
  return {
    type: candidate.type,
    properties: typeof properties === "object" && properties !== null ? (properties as Record<string, unknown>) : {},
  };
}

async function describeResponseBody(response: LongLivedResponse): Promise<string> {
  try {
    return (await response.text()).trim().slice(0, 500);
  } catch {
    return "no error body";
  }
}

function describeJson(value: unknown): string {
  try {
    return JSON.stringify(value).slice(0, 500);
  } catch {
    return String(value);
  }
}

export interface OpencodeRunInputWiring {
  readonly requestRunInput: RequestRunInput;
  readonly recordRunUpdate: RecordRunUpdate;
  readonly mcpBackendFactory: RunMcpBackendFactory;
}

// How long the model may be idle (no session events while no tool is running)
// before the watchdog emits a heartbeat log. This is NOT an abort: opencode
// itself waits/retries when the model is temporarily unavailable (rate limit,
// overload, dropped socket) — the same mechanism the CLI relies on to wait for
// quota to resume. Aborting and re-sending the prompt would discard that
// in-flight retry and hit the same unavailable model, observed in production as
// a run that thrashes every few minutes for an hour. Instead the watchdog just
// logs so an operator can see the session is quiet; the run's own AbortSignal
// (the 1h per-consumer run timeout) bounds a permanently dead model. A healthy
// model usually streams within seconds, but a large prompt can take a minute or
// two to first token, and legitimate tool execution (which is exempt from this
// timer via pendingTools) may run far longer.
const DEFAULT_MODEL_IDLE_THRESHOLD_MS = 5 * 60 * 1000;

// Total model-idle time a run may accumulate before the watchdog aborts the
// prompt attempt with ModelStreamStalledError (see the watchdog for the full
// rationale). 20 minutes: four heartbeat windows of dead air is conclusive
// evidence of a dead provider stream, while a run with genuine work still has
// most of its 1h budget left.
const DEFAULT_MAX_CUMULATIVE_MODEL_IDLE_MS = 20 * 60 * 1000;

// How many times sendWithRetry re-sends the prompt after a ModelStreamStalledError
// abort before letting the error propagate as terminal. A model stall is safe
// to retry (no tool is in flight); each retry gives the provider a fresh
// window, bounded so a hard outage surfaces as a distinct failure instead of
// burning the whole run budget.
const DEFAULT_MODEL_STALL_RETRIES = 2;

// Pause before re-sending the prompt after a model-stall abort. Unlike
// transient network failures (exponential backoff), a stall abort already
// waited out a long dead-air window; a short pause suffices.
const MODEL_STALL_RETRY_DELAY_MS = 15 * 1000;

// How long a single in-flight tool may go with NO session activity before it is
// treated as hung (tool.called with no matching tool.success/tool.failed). A
// legitimately slow tool that streams output keeps the idle clock fresh; only a
// tool producing nothing for this long is stuck. Bounded well below the run's 1h
// hard timeout so a hung bash/subagent/MCP call surfaces as a fast, diagnosable
// failure instead of a silent RunTimeoutError at the hour mark.
const DEFAULT_TOOL_STALL_TIMEOUT_MS = 15 * 60 * 1000;

// The per-run `ask_question` MCP tool blocks until a human submits a form. A
// user can take many minutes — and by design up to a full day — to respond, far
// longer than opencode's ~60s default MCP request timeout, which would abort
// the call, discard the answer when it finally arrives, and leave the run hung.
// We therefore configure an explicit per-server `timeout` on the
// concord-run-tools MCP entry sized to the maximum input wait plus this buffer.
// The run's own input-wait bound (see RunDispatcher) always fires first; the
// buffer just guarantees the MCP clock never wins the race. Instant tools on
// the same server (post_update) return immediately and are unaffected.
// See https://opencode.ai/config.json (McpRemoteConfig.timeout).
const MCP_TOOLS_TIMEOUT_BUFFER_MS = 60_000;
const MCP_TOOLS_TIMEOUT_MS: number = DEFAULT_RUN_INPUT_TIMEOUT_MS + MCP_TOOLS_TIMEOUT_BUFFER_MS;

export class OpencodeSdkRunner implements OpencodeRunner {
  private readonly spawner: OpencodeServerSpawner;
  private readonly runActivityEmitter: RunActivityEmitter;
  private readonly modelIdleThresholdMs: number;
  private readonly toolStallTimeoutMs: number;
  private readonly maxCumulativeModelIdleMs: number;
  private readonly maxModelStallRetries: number;

  public constructor(
    spawner?: OpencodeServerSpawner,
    private readonly clientFactory: OpencodeClientFactory = new HttpApiV2OpencodeClientFactory(),
    private readonly portAllocator: PortAllocator = freePort,
    private readonly runInput: OpencodeRunInputWiring | null = null,
    private readonly logger: Logger = noopLogger,
    runActivityEmitter?: RunActivityEmitter,
    modelIdleThresholdMs: number = DEFAULT_MODEL_IDLE_THRESHOLD_MS,
    toolStallTimeoutMs: number = DEFAULT_TOOL_STALL_TIMEOUT_MS,
    maxCumulativeModelIdleMs: number = DEFAULT_MAX_CUMULATIVE_MODEL_IDLE_MS,
    maxModelStallRetries: number = DEFAULT_MODEL_STALL_RETRIES,
  ) {
    this.spawner = spawner ?? new ChildProcessOpencodeSpawner(new PathBinaryResolver(), this.logger);
    this.runActivityEmitter = runActivityEmitter ?? new NoOpRunActivityEmitter();
    this.modelIdleThresholdMs = modelIdleThresholdMs;
    this.toolStallTimeoutMs = toolStallTimeoutMs;
    this.maxCumulativeModelIdleMs = maxCumulativeModelIdleMs;
    this.maxModelStallRetries = maxModelStallRetries;
  }

  public async run(directory: string, prompt: string, options: OpencodeRunnerOptions, signal?: AbortSignal): Promise<void> {
    await this.runSession(directory, prompt, options, undefined, signal);
  }

  public async runStructured(directory: string, prompt: string, schema: object, options: OpencodeRunnerOptions, signal?: AbortSignal): Promise<unknown> {
    return this.runSession(directory, prompt, options, schema, signal);
  }

  private async runSession(
    directory: string,
    promptText: string,
    options: OpencodeRunnerOptions,
    schema?: object,
    signal?: AbortSignal,
  ): Promise<unknown> {
    requireAgentConfigured(options);

    // The per-run MCP server (concord-run-tools) is started before spawning
    // opencode so its endpoint can be registered through the
    // OPENCODE_CONFIG_CONTENT env var. It always hosts post_update (the model
    // should always be able to inform the operator) and additionally hosts
    // ask_question when maxInputRounds is greater than zero. The backend is
    // started (listening) before spawn so the endpoint URL is stable; the tools
    // themselves are registered after createSession, once the session id needed
    // for the run.update frame is known. One port + one config entry covers both
    // tools, avoiding a second MCP server and process.
    let toolsServer: ToolsServerHandle | null = null;
    let toolsBackend: RunMcpBackend | null = null;
    if (this.runInput !== null) {
      const port = await this.portAllocator();
      toolsBackend = await this.runInput.mcpBackendFactory.create(port);
      await toolsBackend.start();
      toolsServer = {
        endpoint: `http://${HOST}:${port}/mcp`,
        close: () => toolsBackend!.close(),
      };
    }

    // OpenCode 2.x requires HTTP Basic auth on the API. The runner pins a
    // per-run random password on the spawned server (OPENCODE_SERVER_PASSWORD)
    // and
    // authenticates the API client with the same secret. The server listens on
    // 127.0.0.1 only and dies with the run, so the secret's lifetime is the
    // run itself.
    const auth: OpencodeServerAuth = { password: randomBytes(24).toString("hex") };
    const env = buildSpawnEnv(options.githubToken, toolsServer, MCP_TOOLS_TIMEOUT_MS, auth.password);
    let server: OpencodeServerHandle;
    try {
      server = await this.spawnHealthyServer(directory, env);
    } catch (cause) {
      await closeToolsServer(toolsServer);
      throw cause;
    }

    if (signal !== undefined && signal.aborted) {
      server.kill();
      await closeToolsServer(toolsServer);
      throw new UnexpectedStateError("opencode session aborted before start");
    }

    const onAbort = (): void => {
      server.kill();
    };
    if (signal !== undefined) {
      signal.addEventListener("abort", onAbort);
    }
    let eventSubscription: OpencodeEventSubscription | null = null;
    let activityConsumer: Promise<void> | null = null;
    const watchdog = new SessionStallWatchdog(
      this.modelIdleThresholdMs,
      this.logger,
      {},
      this.toolStallTimeoutMs,
      this.maxCumulativeModelIdleMs,
    );
    try {
      const baseUrl = `http://${HOST}:${server.port}`;
      const client = await this.clientFactory.create(baseUrl, auth);
      const sessionId = await createSessionWithRetry({
        createSession: () => client.createSession(directory, options),
        maxAttempts: MAX_SESSION_CREATE_ATTEMPTS,
        delayMs: SESSION_CREATE_RETRY_DELAY_MS,
      });

      // Now that the session id is known, register the per-run tools on the
      // shared backend. post_update is always available; ask_question is
      // registered only when the consumer allows input rounds. The agent
      // discovers tools during the prompt (after this point), so registering
      // here is in time for tools/list.
      if (toolsBackend !== null && this.runInput !== null) {
        const runUpdateServer = new RunUpdateMcpServer(
          this.runInput.recordRunUpdate,
          this.runActivityEmitter,
          options.runId,
          options.consumerId,
          sessionId,
          this.portAllocator,
          this.runInput.mcpBackendFactory,
        );
        runUpdateServer.registerTools(toolsBackend);
        if (options.maxInputRounds > 0) {
          const runInputServer = RunInputMcpServer.boundTo(this.runInput.requestRunInput, {
            runId: options.runId,
            consumerId: options.consumerId,
            portAllocator: this.portAllocator,
            backendFactory: this.runInput.mcpBackendFactory,
          });
          runInputServer.registerTools(toolsBackend);
        }
      }

      // The stall watchdog needs the session's event stream to distinguish a
      // model stall (no events, no tool running) from legitimate long tool
      // execution. Subscribe unconditionally for the watchdog and forward every
      // session-matching event to the activity emitter unconditionally — the
      // broadcaster's per-run routing decides whether any browser actually
      // receives the frame, so the runner stays free of per-run/per-client
      // knowledge. A failed subscription is best-effort: the run continues
      // without stall protection and falls back to the run's own timeout.
      try {
        eventSubscription = await client.subscribeEvents(directory);
      } catch (cause) {
        this.logger.warn("opencode-runner", "session event subscription failed; stall watchdog disabled", {
          runId: options.runId,
          consumerId: options.consumerId,
          error: describeCause(cause),
        });
      }

      if (eventSubscription !== null) {
        watchdog.arm();
        activityConsumer = this.consumeActivityEvents(
          eventSubscription,
          sessionId,
          options.runId,
          options.consumerId,
          signal,
          watchdog,
        );
      }

      return await this.sendWithRetry(client, sessionId, promptText, options, schema, signal, server, watchdog);
    } finally {
      // When a run is aborted (per-consumer timeout or manual abort) the generic
      // RunTimeoutError carries no clue about what the agent was doing. Emit the
      // watchdog's final state so the failure self-documents: pendingTools>0 with
      // large idleMs is a hung tool, armed=false means stall protection was off
      // (event subscription failed), and a small idleMs points at a busy loop.
      if (signal !== undefined && signal.aborted) {
        this.logger.warn("opencode-runner", "run aborted by signal; stall watchdog snapshot", {
          runId: options.runId,
          consumerId: options.consumerId,
          eventSubscriptionActive: eventSubscription !== null,
          ...watchdog.snapshot(),
        });
      }
      watchdog.disarm();
      if (eventSubscription !== null) {
        eventSubscription.close();
      }
      if (activityConsumer !== null) {
        activityConsumer.catch(() => {
          // best-effort: the consumer swallows its own errors; this guard
          // prevents an unhandled rejection if the close races the generator.
        });
      }
      if (signal !== undefined) {
        signal.removeEventListener("abort", onAbort);
      }
      server.kill();
      await closeToolsServer(toolsServer);
    }
  }

  private async consumeActivityEvents(
    subscription: OpencodeEventSubscription,
    sessionId: string,
    runId: string,
    consumerId: string,
    signal: AbortSignal | undefined,
    watchdog: SessionStallWatchdog,
  ): Promise<void> {
    try {
      for await (const event of subscription.events) {
        if (signal !== undefined && signal.aborted) {
          break;
        }
        const eventSessionId = extractSessionId(event);
        if (eventSessionId !== sessionId) {
          continue;
        }
        // Feed every session event to the watchdog so it can reset its idle
        // timer and track running tools, regardless of external subscribers.
        watchdog.observe(event);
        // Forward every matching event unconditionally. The broadcaster routes
        // each frame per run (only clients subscribed to this run receive it),
        // so whether a frame reaches a browser is decided entirely by the UI's
        // subscribe/unsubscribe — the runner never consults hasSubscribers.
        this.runActivityEmitter.emit({
          runId,
          consumerId,
          sessionId,
          kind: event.type,
          payload: event.properties,
          at: new Date().toISOString(),
        });
      }
    } catch {
      // The event stream is best-effort: any error is swallowed because the
      // runSession finally block closes the subscription and kills the server
      // regardless. An error here (e.g. the SSE connection dropping) must not
      // crash the run or surface to the operator.
    }
  }

  // Sends the prompt, retrying transient failures (network errors and empty
  // model-API responses) with exponential backoff until the signal aborts
  // (per-consumer run timeout or manual abort) or a non-transient error occurs.
  // Each attempt runs under its own AbortController so the watchdog can abort
  // just that attempt on a tool stall (a terminal failure) without aborting the
  // whole run.
  //
  // Model availability is deliberately NOT retried here on short horizons.
  // When the model is temporarily unavailable (rate limit, overload, dropped
  // socket) opencode itself waits and retries — the same logic the opencode CLI
  // relies on to wait for quota to resume. Re-sending the prompt from scratch
  // on our own short timer would discard that in-flight retry and create a new
  // prompt that hits the same unavailable model, so the watchdog only emits
  // heartbeats for model idleness and lets opencode recover.
  //
  // The one exception is the watchdog's cumulative model-idle budget: once
  // TOTAL dead air for the run exceeds it, the stream is dead rather than
  // transiently unavailable, and the watchdog aborts the attempt with
  // ModelStreamStalledError. That abort is retried here (bounded by
  // maxModelStallRetries) because it is safe — no tool is in flight — and each
  // retry gives the provider a fresh window. Exhausting the retries propagates
  // the error as terminal, surfacing as a distinct run failure errorName.
  //
  // Without a signal there is no bound on retries, so we fail fast to preserve
  // prior behaviour; in production RunDispatcher always passes a bounded signal.
  private async sendWithRetry(
    client: OpencodePromptClient,
    sessionId: string,
    promptText: string,
    options: OpencodeRunnerOptions,
    schema: object | undefined,
    signal: AbortSignal | undefined,
    server: OpencodeServerHandle,
    watchdog: SessionStallWatchdog,
  ): Promise<unknown> {
    if (signal === undefined) {
      try {
        return await client.prompt(sessionId, promptText, options, schema, signal);
      } catch (cause) {
        throw enrichPromptFailure(cause, server, this.logger);
      }
    }
    let attemptNumber = 0;
    let modelStallRetries = 0;
    while (true) {
      if (signal.aborted) {
        throw enrichPromptFailure(new UnexpectedStateError("opencode session aborted before prompt"), server, this.logger);
      }
      const attemptController = linkAbortController(signal);
      watchdog.beginAttempt(attemptController);
      try {
        return await client.prompt(sessionId, promptText, options, schema, attemptController.signal);
      } catch (cause) {
        // A tool stall means a tool hung in-flight and is terminal — the
        // opencode server may still be executing that tool, so re-sending the
        // prompt is unsafe, and the model would only re-request the same tool.
        const abortedReason = attemptController.signal.aborted ? attemptController.signal.reason : undefined;
        if (abortedReason instanceof ToolStreamStalledError) {
          throw enrichPromptFailure(abortedReason, server, this.logger);
        }
        // A model stall (cumulative model-idle budget exceeded) is safe to
        // retry — no tool is in flight — and each retry hands the provider a
        // fresh stream. Bounded by maxModelStallRetries so a hard outage
        // surfaces as a distinct terminal failure rather than burning the
        // whole run budget on dead air.
        if (abortedReason instanceof ModelStreamStalledError) {
          if (modelStallRetries >= this.maxModelStallRetries) {
            this.logger.warn("opencode-runner", "model stall retries exhausted, failing run", {
              modelStallRetries,
              maxModelStallRetries: this.maxModelStallRetries,
              error: abortedReason.message,
            });
            throw enrichPromptFailure(abortedReason, server, this.logger);
          }
          modelStallRetries = modelStallRetries + 1;
          this.logger.warn("opencode-runner", "model stall detected, interrupting session and re-sending prompt", {
            modelStallRetry: modelStallRetries,
            maxModelStallRetries: this.maxModelStallRetries,
            delayMs: MODEL_STALL_RETRY_DELAY_MS,
            error: abortedReason.message,
          });
          // Aborting the wait request does NOT stop the server-side
          // generation (unlike V1's blocking prompt request). Interrupt the
          // session so the wedged generation stops and the re-sent prompt is
          // not queued behind a stream that will never complete. Best-effort:
          // an interrupt failure must not mask the stall retry.
          try {
            await client.interrupt(sessionId);
          } catch (interruptCause) {
            this.logger.warn("opencode-runner", "session interrupt failed after model stall", {
              runId: options.runId,
              consumerId: options.consumerId,
              error: describeCause(interruptCause),
            });
          }
          await abortableDelay(MODEL_STALL_RETRY_DELAY_MS, signal);
          continue;
        }
        if (signal.aborted || !isRetryablePromptFailure(cause, signal)) {
          throw enrichPromptFailure(cause, server, this.logger);
        }
        const delayMs = retryDelayMs(attemptNumber);
        this.logger.warn("opencode-runner", "transient prompt failure, retrying", {
          attempt: attemptNumber + 1,
          delayMs,
          error: describeCauseChain(cause),
        });
        await abortableDelay(delayMs, signal);
        attemptNumber = attemptNumber + 1;
      } finally {
        watchdog.endAttempt();
        attemptController.unlink();
      }
    }
  }

  private async spawnHealthyServer(
    directory: string,
    env: Record<string, string> | undefined,
  ): Promise<OpencodeServerHandle> {
    for (let attempt = 0; attempt < SPAWN_ATTEMPTS; attempt = attempt + 1) {
      const port = await this.portAllocator();
      try {
        return await this.spawner.spawn(directory, port, env);
      } catch (cause) {
        // concord#24: a vanished spawn directory is structural, not
        // transient — retrying cannot recreate it. Surface the named error
        // immediately instead of burning the attempt loop.
        if (cause instanceof WorktreeVanishedError) {
          throw cause;
        }
        if (attempt + 1 >= SPAWN_ATTEMPTS) {
          throw new UnexpectedStateError(
            `opencode server did not become healthy after ${SPAWN_ATTEMPTS} attempts: ${describeCause(cause)}`,
          );
        }
      }
    }
    throw new UnexpectedStateError("opencode spawnHealthyServer exited its retry loop without returning");
  }
}

function githubTokenEnvOverlay(githubToken: string | undefined): Record<string, string> | undefined {
  if (typeof githubToken !== "string" || githubToken.length === 0) {
    return undefined;
  }
  const credentials = `x-access-token:${githubToken}`;
  const encoded = Buffer.from(credentials, "utf8").toString("base64");
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${encoded}`,
  };
}

// The inline opencode config injected into every spawned server, serialized
// into the OPENCODE_CONFIG_CONTENT env var. opencode merges it (precedence:
// runtime override) with any existing project/global config, so other MCP
// servers and permission rules are preserved/overridden as expected. The
// permissions array ALWAYS allows every action; `mcp.servers` is present only
// when a per-run tools server is wired. Shapes are native OpenCode 2.x (see
// https://opencode.ai/docs/config).
type InlineOpencodeConfig = {
  permissions: Array<{ action: string; resource: string; effect: "allow" }>;
  mcp?: {
    servers: Record<string, {
      type: "remote";
      url: string;
      // The concord tools endpoint has no OAuth; without `oauth: false` the
      // 2.x remote transport defaults to OAuth discovery and parks the server
      // in "needs authentication".
      oauth: false;
      timeout: { execution: number };
    }>;
  };
};

// Builds the env overlay passed to the opencode spawn. Merges the GitHub token
// GIT_CONFIG overlay and the OPENCODE_SERVER_PASSWORD server credential with
// OPENCODE_CONFIG_CONTENT inline config built by buildInlineConfig. The overlay
// is always non-empty, so this never returns undefined.
function buildSpawnEnv(
  githubToken: string | undefined,
  toolsServer: ToolsServerHandle | null,
  toolsTimeoutMs: number,
  serverPassword: string,
): Record<string, string> {
  const overlay: Record<string, string> = {};
  const tokenOverlay = githubTokenEnvOverlay(githubToken);
  if (tokenOverlay !== undefined) {
    Object.assign(overlay, tokenOverlay);
  }
  // opencode 2.x does not read OPENCODE_PASSWORD; without the correct env var
  // the server starts unsecured and rejects the client's Basic auth.
  overlay.OPENCODE_SERVER_PASSWORD = serverPassword;
  overlay.OPENCODE_CONFIG_CONTENT = JSON.stringify(buildInlineConfig(toolsServer, toolsTimeoutMs));
  return overlay;
}

// The inline config always pre-approves every permission action, and
// additionally registers the per-run concord-run-tools MCP server endpoint
// (hosting post_update and, when enabled, ask_question) when a tools server is
// present.
//
// Autonomous agent runs have no human at a TTY to answer opencode's permission
// prompts. Any unresolved permission check waits for a client reply that never
// arrives. In production (V1) this surfaced as a fix run that issued
// `rm -f /tmp/mock-trace.log`, sat idle on permission.asked for ~44 minutes,
// and was killed by the 1h per-consumer hard timeout. Pre-approving removes
// that gate. The run's own boundaries (an isolated worktree, a scoped GitHub
// token, and the per-consumer run timeout) are the real safety fence; a
// permission prompt is not a meaningful guard when nobody can answer it.
function buildInlineConfig(toolsServer: ToolsServerHandle | null, toolsTimeoutMs: number): InlineOpencodeConfig {
  const config: InlineOpencodeConfig = {
    permissions: [{ action: "*", resource: "*", effect: "allow" }],
  };
  if (toolsServer !== null) {
    config.mcp = {
      servers: {
        [RUN_TOOLS_MCP_SERVER_NAME]: {
          type: "remote",
          url: toolsServer.endpoint,
          oauth: false,
          // Sized to the maximum input wait so ask_question can block for a
          // human response without opencode's MCP execution timeout aborting
          // it. `execution` covers tool calls (the V1 scalar `timeout` became
          // { catalog, execution } in 2.x).
          timeout: { execution: toolsTimeoutMs },
        },
      },
    };
  }
  return config;
}

interface ToolsServerHandle {
  readonly endpoint: string;
  close(): Promise<void>;
}

async function closeToolsServer(toolsServer: ToolsServerHandle | null): Promise<void> {
  if (toolsServer === null) {
    return;
  }
  try {
    await toolsServer.close();
  } catch {
    // best-effort teardown of the per-run tools MCP backend
  }
}

// The OpenCode event stream is per-server (scoped to the worktree directory the
// server was spawned in), not per-session: a single server may host subagent or
// fork sessions whose events the runner does not want to surface. Every
// session-scoped 2.x event carries the session id in its data payload (mapped
// onto properties by parseSseFrame). Events without a session id (e.g.
// server.connected) never match and are silently dropped.
function extractSessionId(event: OpencodeEvent): string | undefined {
  return (event.properties as { sessionID?: string }).sessionID;
}

// Agent and model are required per consumer, not optional. Without them
// opencode either crashes (an unknown agent id makes createUserMessage throw
// UnknownError) or runs against an unintended model. Fail fast with a clear,
// non-retryable error so the operator sets the config instead of the run
// looping until its timeout.
function requireAgentConfigured(options: OpencodeRunnerOptions): void {
  if (options.agentId.length === 0) {
    throw new UnexpectedStateError(
      `Consumer "${options.consumerId}" cannot run: no agent configured. Set the "Agent" (agentName) consumer config parameter.`,
    );
  }
  if (options.modelId.length === 0) {
    throw new UnexpectedStateError(
      `Consumer "${options.consumerId}" cannot run: no model configured. Set the "Model" (modelId) consumer config parameter.`,
    );
  }
}

function splitModelId(modelId: string): { providerID: string; modelID: string } {
  const slash = modelId.indexOf("/");
  if (slash < 0) {
    return { providerID: "", modelID: modelId };
  }
  return { providerID: modelId.slice(0, slash), modelID: modelId.slice(slash + 1) };
}

// OpenCode 2.x moved agent and model from the prompt body to session creation
// (POST /api/session). The model reference uses the 2.x Model.Ref shape with
// `id` (not the V1 SDK's `modelID`).
export type SessionCreateBody = {
  agent: string;
  model?: { providerID: string; id: string };
  location: { directory: string };
};

export function buildSessionCreateBody(directory: string, options: OpencodeRunnerOptions): SessionCreateBody {
  const body: SessionCreateBody = {
    agent: options.agentId,
    location: { directory },
  };
  if (options.modelId.length > 0) {
    const { providerID, modelID } = splitModelId(options.modelId);
    body.model = { providerID, id: modelID };
  }
  return body;
}

// OpenCode 2.x has no native structured output (the V1 prompt `format` field
// and the StructuredOutput tool call no longer exist). The schema travels as an
// explicit output contract appended to the prompt, and the final assistant
// message is parsed for the JSON object (see extractStructuredOutput).
export function withStructuredOutputInstruction(prompt: string, schema: object): string {
  return [
    prompt,
    "",
    "## Required output format",
    "",
    "Your FINAL message must be exactly one JSON object that conforms to this JSON schema:",
    JSON.stringify(schema),
    "Return only the JSON object in the final message — no markdown fences, no commentary, no keys beyond the schema.",
  ].join("\n");
}

type AssistantContentPart = {
  readonly type?: unknown;
  readonly name?: unknown;
  readonly text?: unknown;
  readonly state?: { status?: unknown; input?: unknown } | null;
};

type AssistantMessage = {
  readonly type?: unknown;
  readonly content?: unknown;
  readonly finish?: unknown;
  readonly error?: unknown;
};

function isAssistantMessage(message: unknown): message is AssistantMessage {
  if (typeof message !== "object" || message === null) {
    return false;
  }
  return (message as { type?: unknown }).type === "assistant";
}

function assistantTextParts(message: AssistantMessage): string[] {
  if (!Array.isArray(message.content)) {
    return [];
  }
  const texts: string[] = [];
  for (const part of message.content as AssistantContentPart[]) {
    if (typeof part === "object" && part !== null && part.type === "text" && typeof part.text === "string") {
      texts.push(part.text);
    }
  }
  return texts;
}

function assistantText(message: AssistantMessage): string {
  return assistantTextParts(message).join("");
}

function isStructuredOutputToolPart(part: AssistantContentPart): boolean {
  return part.type === "tool" && part.name === "StructuredOutput";
}

// Parses the first JSON value found in a free-text assistant reply, trying the
// most-likely candidates in order: the whole text, the last fenced block, the
// outermost {...} span, and each trailing line. Models are told to end with
// only the JSON object; anything else is a near-miss this recovers from.
export function extractJsonFromText(text: string): unknown {
  const trimmed = text.trim();
  const candidates: string[] = [];
  if (trimmed.length > 0) {
    candidates.push(trimmed);
  }
  const fenced = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
  if (fenced.length > 0) {
    const last = fenced[fenced.length - 1][1].trim();
    if (last.length > 0) {
      candidates.push(last);
    }
  }
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }
  const lines = trimmed.split("\n");
  for (let index = lines.length - 1; index >= 0; index = index - 1) {
    const line = lines[index].trim();
    if (line.length > 0) {
      candidates.push(line);
    }
  }
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

// Extracts the structured output from a session's message list (newest first,
// per GET /api/session/{id}/message). Two sources, in order:
//  1. Compatibility: an assistant tool call named `StructuredOutput` with a
//     completed input (the V1 delivery shape, in case a server or plugin ever
//     re-introduces it).
//  2. The first assistant message (newest first) whose text parses as JSON.
export function extractStructuredOutput(messages: unknown): unknown {
  if (!Array.isArray(messages)) {
    return undefined;
  }
  const assistants = messages.filter(isAssistantMessage);
  for (const message of assistants) {
    if (!Array.isArray(message.content)) {
      continue;
    }
    for (const part of message.content as AssistantContentPart[]) {
      if (typeof part === "object" && part !== null && isStructuredOutputToolPart(part)) {
        const state = part.state;
        if (state !== null && state !== undefined && state.input !== undefined && state.input !== null) {
          return state.input;
        }
      }
    }
  }
  for (const message of assistants) {
    const parsed = extractJsonFromText(assistantText(message));
    if (parsed !== undefined) {
      return parsed;
    }
  }
  return undefined;
}

// Validates the outcome of a completed prompt turn and classifies it without
// throwing for the recoverable case: a structured-output turn that ended
// without parseable JSON (see promptWithStructuredOutputNudges). The
// unrecoverable cases still throw with the same messages extractPromptResult
// has always produced: an empty turn (no assistant message — retried by
// sendWithRetry) and an errored final assistant turn (deterministic failure
// surfaced to the operator).
export type PromptTurnOutcome =
  | { readonly kind: "structured"; readonly output: unknown }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "missing-structured-output"; readonly finalText: string };

export function classifyPromptTurn(messages: unknown, structured: boolean): PromptTurnOutcome {
  const list = Array.isArray(messages) ? messages : [];
  const finalMessage = list.find(isAssistantMessage);
  if (finalMessage === undefined) {
    throw new UnexpectedStateError("opencode produced no assistant message for the prompt");
  }
  if (finalMessage.error !== undefined && finalMessage.error !== null) {
    throw new UnexpectedStateError(`opencode assistant turn failed: ${describeJson(finalMessage.error)}`);
  }
  if (finalMessage.finish === "error") {
    throw new UnexpectedStateError("opencode assistant turn failed (finish: error)");
  }
  if (structured) {
    const output = extractStructuredOutput(list);
    if (output === undefined) {
      return { kind: "missing-structured-output", finalText: assistantText(finalMessage) };
    }
    return { kind: "structured", output };
  }
  return { kind: "text", text: assistantText(finalMessage) };
}

// Validates the outcome of a completed prompt turn and reduces it to the value
// the runner returns: the parsed structured output, or the final assistant
// text. Throws when the session produced no assistant message at all (empty
// turn — retried by sendWithRetry) or when the final assistant turn errored
// (deterministic failure surfaced to the operator).
export function extractPromptResult(messages: unknown, structured: boolean): unknown {
  const outcome = classifyPromptTurn(messages, structured);
  if (outcome.kind === "missing-structured-output") {
    throw new UnexpectedStateError(
      `Opencode produced no structured output; final assistant text: ${outcome.finalText.slice(0, 500)}`,
    );
  }
  if (outcome.kind === "structured") {
    return outcome.output;
  }
  return outcome.text;
}

// A single prompt→wait cycle, as driven by V2HttpApi.prompt: send the prompt
// text, block until the session goes idle, and return the session's message
// list (newest first).
export type PromptTurnSender = (promptText: string) => Promise<unknown>;

export interface StructuredOutputPromptRequest {
  readonly promptText: string;
  readonly schema: object;
  readonly sendTurn: PromptTurnSender;
  readonly maxNudges: number;
}

// Sends a structured-output prompt and, whenever the agent ends its turn
// without the required JSON object, sends a bounded follow-up prompt to the
// same session telling it to continue inside a single turn. OpenCode 2.x
// marks a session idle as soon as the agent ends a turn, and agents legitimately
// end turns mid-task while background work (e.g. an integration suite) runs,
// assuming something will resume them later — nothing does. The nudge is that
// resume: it makes the agent poll the background work to completion within the
// turn and deliver the JSON. When the nudge budget is exhausted the original
// "no structured output" failure surfaces, so behaviour is unchanged for a
// model that never converges. Empty and errored turns throw from
// classifyPromptTurn exactly as before (the empty turn remains retryable by
// sendWithRetry through its message signature).
export async function promptWithStructuredOutputNudges(request: StructuredOutputPromptRequest): Promise<unknown> {
  let messages = await request.sendTurn(withStructuredOutputInstruction(request.promptText, request.schema));
  for (let nudge = 0; ; nudge = nudge + 1) {
    const outcome = classifyPromptTurn(messages, true);
    if (outcome.kind === "structured") {
      return outcome.output;
    }
    if (outcome.kind === "text") {
      // Unreachable for structured=true; kept explicit so the outcome union is
      // fully handled and a future classifier change cannot fail silently.
      throw new UnexpectedStateError(`opencode structured prompt turn reduced to plain text: ${outcome.text.slice(0, 500)}`);
    }
    if (nudge >= request.maxNudges) {
      throw new UnexpectedStateError(
        `Opencode produced no structured output after ${nudge} follow-up prompt(s); ` +
        `final assistant text: ${outcome.finalText.slice(0, 500)}`,
      );
    }
    messages = await request.sendTurn(withStructuredOutputInstruction(STRUCTURED_OUTPUT_NUDGE_BODY, request.schema));
  }
}

export interface SessionCreateRetryRequest {
  readonly createSession: () => Promise<string>;
  readonly maxAttempts: number;
  readonly delayMs: number;
}

// Detects the opencode 2.x "not yet ready" refusal: the HTTP server (and thus
// /health) is up, but internal services are still initializing and API routes
// answer 503 {"code":"service_starting"}.
export function isServiceStartingFailure(cause: unknown): boolean {
  return causeChainMatches(cause, [/HTTP 503[\s\S]*service_starting/]);
}

// Creates the session, retrying the transient service_starting refusal a
// bounded number of times with a fixed delay (see MAX_SESSION_CREATE_ATTEMPTS
// for the production incident this covers). Any other error — a deterministic
// API failure, a network error, an aborted spawn — propagates unchanged on the
// first attempt; exhausting the attempts rethrows the last service_starting
// failure so the operator sees the real refusal.
export async function createSessionWithRetry(request: SessionCreateRetryRequest): Promise<string> {
  let lastCause: unknown;
  for (let attempt = 1; attempt <= request.maxAttempts; attempt = attempt + 1) {
    try {
      return await request.createSession();
    } catch (cause) {
      if (!isServiceStartingFailure(cause)) {
        throw cause;
      }
      lastCause = cause;
      if (attempt < request.maxAttempts) {
        await delay(request.delayMs);
      }
    }
  }
  throw lastCause;
}

type HealthProbeOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: number; readonly body: string }
  | { readonly ok: false; readonly error: string };

async function waitForHealth(port: number, isDead: () => boolean, logger: Logger): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  const recorder = new HealthProbeRecorder(port, logger, { warnAfterMs: HEALTH_WARN_AFTER_MS, clock: Date.now });
  while (Date.now() < deadline) {
    if (isDead()) {
      throw new UnexpectedStateError(`opencode process exited before becoming healthy on port ${port}`);
    }
    const outcome = await probeHealth(port);
    recorder.record(outcome);
    if (outcome.ok) {
      return;
    }
    await delay(HEALTH_POLL_INTERVAL_MS);
  }
  const summary = recorder.summarize();
  logger.error("opencode-runner", summary);
  throw new UnexpectedStateError(summary);
}

export async function probeHealth(port: number): Promise<HealthProbeOutcome> {
  let response: Response;
  try {
    response = await fetch(`http://${HOST}:${port}/health`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  } catch (cause) {
    return { ok: false, error: describeCause(cause) };
  }
  if (response.ok) {
    return { ok: true };
  }
  let body = "";
  try {
    body = (await response.text()).trim();
  } catch {
    body = "";
  }
  return { ok: false, status: response.status, body: body.slice(0, HEALTH_BODY_LIMIT) };
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", (err) => {
      server.close();
      reject(err);
    });
    server.listen(0, HOST, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new UnexpectedStateError("could not determine the allocated port"));
        return;
      }
      const allocated = address.port;
      server.close(() => {
        resolve(allocated);
      });
    });
  });
}

class ServerProcessLog {
  private readonly chunks: string[] = [];
  private length = 0;
  private truncated = false;
  private exitReason = "";

  public constructor(child: ChildProcess) {
    child.stdout?.on("data", (data) => this.append(data));
    child.stderr?.on("data", (data) => this.append(data));
    child.on("error", (err) => {
      this.exitReason = `process error: ${err.message}`;
    });
    child.on("exit", (code, signal) => {
      if (code !== null && code !== 0) {
        this.exitReason = `process exited with code ${code}`;
      } else if (signal !== null) {
        this.exitReason = `process exited with signal ${signal}`;
      }
    });
  }

  private append(data: Buffer | string): void {
    if (this.truncated) {
      return;
    }
    const text = typeof data === "string" ? data : data.toString("utf8");
    this.chunks.push(text);
    this.length = this.length + text.length;
    if (this.length > OUTPUT_LIMIT) {
      this.chunks.length = 0;
      this.chunks.push("[output truncated]");
      this.truncated = true;
    }
  }

  public summary(): string {
    const output = this.chunks.join("").trim();
    if (this.exitReason.length > 0 && output.length > 0) {
      return `${this.exitReason}; ${output}`;
    }
    if (this.exitReason.length > 0) {
      return this.exitReason;
    }
    return output;
  }
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.message;
  }
  return String(cause);
}

// When the SDK's prompt request fails mid-session, the spawned opencode process
// usually holds the reason in its stdout/stderr or exit code. The health-check
// path already surfaces this on startup; without enrichment here the run fails
// with a bare "fetch failed" and the subprocess output is lost when kill() runs.
function enrichPromptFailure(cause: unknown, server: OpencodeServerHandle, logger: Logger): unknown {
  // Model-stall errors are self-diagnosing (budget, cumulative and episode
  // idle are all in the message) and must keep their identity: the run
  // dispatcher classifies them by error name to record the sentinel failure
  // and drive the bounded re-dispatch. Replacing them with a generic
  // UnexpectedStateError here would bury the signature when the server has
  // diagnostics output.
  if (cause instanceof ModelStreamStalledError) {
    return cause;
  }
  const output = server.diagnostics().trim();
  if (output.length === 0) {
    return cause;
  }
  const message = `opencode prompt request failed (${describeCauseChain(cause)}): ${output}`;
  logger.error("opencode-runner", message);
  return new UnexpectedStateError(message);
}

// Walks an error's `.cause` chain so the underlying reason (e.g. an undici
// HeadersTimeoutError behind a "fetch failed" TypeError) is not hidden.
function describeCauseChain(cause: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = cause;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    if (current.message.length > 0) {
      parts.push(current.message);
    }
    current = (current as { cause?: unknown }).cause;
  }
  return parts.length > 0 ? parts.join(" :: caused by: ") : describeCause(cause);
}

// Signatures of transient connectivity errors observed in the wild (see
// concord.err.log): fetch failures, TCP resets, DNS hiccups, undici timeouts.
const PROMPT_NETWORK_ERROR_PATTERNS: ReadonlyArray<RegExp> = [
  /fetch failed/i,
  /ECONNREFUSED/i,
  /EAI_AGAIN/i,
  /ENOTFOUND/i,
  /ECONNRESET/i,
  /EPIPE/i,
  /Connect Timeout/i,
  /other side closed/i,
  /ETIMEDOUT/i,
  /UND_ERR/i,
  /socket hang up/i,
  /network error/i,
];

// A prompt turn can come back with no usable payload when the session went
// idle without ever producing an assistant message: the model API errored in a
// way opencode swallowed, or the wait raced the prompt delivery. Re-asking is
// safe (a fresh user message simply starts another turn), so it is retried.
// A turn that ERRORED (finish/error fields) is a surfaced, deterministic
// failure and must NOT be retried.
const PROMPT_EMPTY_RESPONSE_PATTERNS: ReadonlyArray<RegExp> = [
  /produced no assistant message/i,
];

// The spawned server can still be answering 503 {"code":"service_starting"}
// when the first prompt is sent (see MAX_SESSION_CREATE_ATTEMPTS): /health
// passes before opencode's internal services finish initializing. The refusal
// is transient and side-effect free, so the prompt is re-sent.
const PROMPT_SERVICE_STARTING_PATTERNS: ReadonlyArray<RegExp> = [
  /HTTP 503[\s\S]*service_starting/,
];

function causeChainMatches(cause: unknown, patterns: ReadonlyArray<RegExp>): boolean {
  let current: unknown = cause;
  while (current instanceof Error) {
    const message = current.message;
    if (patterns.some((pattern) => pattern.test(message))) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

// A prompt failure is retryable when it looks like a transient connectivity or
// model-API issue — not when the signal already fired (timeout / manual abort)
// or when the error is deterministic (bad config, missing StructuredOutput).
export function isRetryablePromptFailure(cause: unknown, signal: AbortSignal | undefined): boolean {
  if (signal !== undefined && signal.aborted) {
    return false;
  }
  if (cause instanceof DOMException) {
    return false;
  }
  if (causeChainMatches(cause, PROMPT_NETWORK_ERROR_PATTERNS)) {
    return true;
  }
  if (cause instanceof UnexpectedStateError && causeChainMatches(cause, PROMPT_SERVICE_STARTING_PATTERNS)) {
    return true;
  }
  if (cause instanceof UnexpectedStateError && causeChainMatches(cause, PROMPT_EMPTY_RESPONSE_PATTERNS)) {
    return true;
  }
  return false;
}

export function retryDelayMs(attempt: number): number {
  const delay = PROMPT_RETRY_INITIAL_DELAY_MS * Math.pow(PROMPT_RETRY_BACKOFF_MULTIPLIER, attempt);
  return Math.min(delay, PROMPT_RETRY_MAX_DELAY_MS);
}

// A delay that resolves early when the signal aborts, so the retry loop wakes
// up immediately on timeout / manual abort instead of waiting out the full
// backoff. Resolves (does not reject) — the loop re-checks signal.aborted.
function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

// A per-prompt-attempt AbortController that follows the run's signal: when the
// run aborts (timeout / manual abort) the attempt aborts with the run's reason,
// but the attempt can also be aborted independently by the stall watchdog. This
// lets the watchdog fail a single stalled attempt for retry without aborting
// the whole run. If the source is already aborted, the attempt is created in an
// already-aborted state mirroring the source reason.
interface LinkedAttempt {
  readonly signal: AbortSignal;
  unlink(): void;
}

function linkAbortController(source: AbortSignal): LinkedAttempt & StallAbortTarget {
  const controller = new AbortController();
  const unlink = (): void => {
    source.removeEventListener("abort", onSourceAbort);
  };
  const onSourceAbort = (): void => {
    controller.abort(source.reason);
  };
  if (source.aborted) {
    controller.abort(source.reason);
  } else {
    source.addEventListener("abort", onSourceAbort, { once: true });
  }
  return {
    signal: controller.signal,
    abort: (reason?: unknown) => controller.abort(reason),
    unlink,
  };
}

// Timing configuration for HealthProbeRecorder. `warnAfterMs` is the elapsed
// readiness time after which a still-failing probe warns (a fraction of the
// HEALTH_TIMEOUT_MS budget); `clock` is injected so the deadline behaviour is
// deterministically testable without real sleeps.
export interface HealthProbeTiming {
  readonly warnAfterMs: number;
  readonly clock: () => number;
}

export class HealthProbeRecorder {
  private probeCount = 0;
  private failedProbeCount = 0;
  private readonly statuses = new Set<number>();
  private lastBody = "";
  private lastError = "";
  private warned = false;
  private readonly startedAt: number;

  public constructor(
    private readonly port: number,
    private readonly logger: Logger,
    timing: HealthProbeTiming,
  ) {
    this.warnAfterMs = timing.warnAfterMs;
    this.clock = timing.clock;
    this.startedAt = this.clock();
  }

  private readonly warnAfterMs: number;
  private readonly clock: () => number;

  public record(outcome: HealthProbeOutcome): void {
    this.probeCount = this.probeCount + 1;
    if (outcome.ok) {
      return;
    }
    this.failedProbeCount = this.failedProbeCount + 1;
    if ("status" in outcome) {
      this.statuses.add(outcome.status);
      this.lastBody = outcome.body;
    } else {
      this.lastError = outcome.error;
    }
    // Warn only once failed probes have consumed a meaningful fraction of the
    // readiness deadline (see HEALTH_WARN_AFTER_MS). The socket-binds-before-
    // handler startup window fails the first ~1-2s of probes on every healthy
    // spawn; warning there is pure noise. Past the fraction, a true readiness
    // failure is imminent and the warning carries the elapsed time and probe
    // count so the operator can see how close to the deadline it is.
    if (this.warned) {
      return;
    }
    const elapsedMs = this.clock() - this.startedAt;
    if (elapsedMs < this.warnAfterMs) {
      return;
    }
    this.warned = true;
    const detail = "status" in outcome
      ? `http ${outcome.status}${outcome.body.length > 0 ? ` - ${outcome.body}` : ""}`
      : `connection error: ${outcome.error}`;
    this.logger.warn("opencode-runner", "opencode /health not healthy", {
      port: this.port,
      detail,
      probes: this.failedProbeCount,
      elapsedMs,
    });
  }

  public summarize(): string {
    const parts: string[] = [
      `opencode server on port ${this.port} did not become healthy after ${this.probeCount} health probe(s)`,
    ];
    if (this.statuses.size > 0) {
      const ordered = [...this.statuses].sort((a, b) => a - b).join(",");
      parts.push(`http statuses observed: ${ordered}`);
    }
    if (this.lastBody.length > 0) {
      parts.push(`last response body: ${this.lastBody}`);
    }
    if (this.lastError.length > 0) {
      parts.push(`last connection error: ${this.lastError}`);
    }
    if (this.probeCount === 0) {
      parts.push("no health probes completed");
    }
    return parts.join("; ");
  }
}

