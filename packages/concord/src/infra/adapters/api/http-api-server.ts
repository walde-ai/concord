import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { EventStore } from "../../../domain/ports/out/event-store";
import type { RunRepository } from "../../../domain/ports/out/run-repository";
import type { ListProducers } from "../../../domain/ports/in/list-producers";
import type { ListConsumers } from "../../../domain/ports/in/list-consumers";
import type { SetProducerEnabled } from "../../../domain/ports/in/set-producer-enabled";
import type { SetConsumerEnabled } from "../../../domain/ports/in/set-consumer-enabled";
import type { CreateContext } from "../../../domain/ports/in/create-context";
import type { UpdateContext } from "../../../domain/ports/in/update-context";
import type { DeleteContext } from "../../../domain/ports/in/delete-context";
import type { ListContexts } from "../../../domain/ports/in/list-contexts";
import type { BeginLogin } from "../../../domain/ports/in/begin-login";
import type { CompleteLogin } from "../../../domain/ports/in/complete-login";
import type { AuthenticateRequest } from "../../../domain/ports/in/authenticate-request";
import type { EmitEvent } from "../../../domain/ports/in/emit-event";
import type { GetPauseState } from "../../../domain/ports/in/get-pause-state";
import type { SetPauseState } from "../../../domain/ports/in/set-pause-state";
import type { ReplayEvent } from "../../../domain/ports/in/replay-event";
import type { AbortRun } from "../../../domain/ports/in/abort-run";
import type { RestartRun } from "../../../domain/ports/in/restart-run";
import type { SubmitRunInput } from "../../../domain/ports/in/submit-run-input";
import type { ListEventTemplates } from "../../../domain/ports/in/list-event-templates";
import type { EmitEventTemplate } from "../../../domain/ports/in/emit-event-template";
import type { ResolveEventTemplateFieldOptions } from "../../../domain/ports/in/resolve-event-template-field-options";
import type { GetPeakHours } from "../../../domain/ports/in/get-peak-hours";
import type { SetPeakHours } from "../../../domain/ports/in/set-peak-hours";
import type { SetConsumerWaitForOffPeak } from "../../../domain/ports/in/set-consumer-wait-for-off-peak";
import type { SetConsumerConfig } from "../../../domain/ports/in/set-consumer-config";
import type { SetConsumerSecrets } from "../../../domain/ports/in/set-consumer-secrets";
import type { SignedRequest } from "../../../domain/ports/out/signed-request";
import type { FormRepository } from "../../../domain/ports/out/form-repository";
import type { RunUpdateRepository } from "../../../domain/ports/out/run-update-repository";
import type { QueryLogs } from "../../../domain/ports/in/query-logs";
import type { LogStore } from "../../../domain/ports/out/log-store";
import type { LogLevel } from "../../../domain/ports/out/logger";
import type { ContextSecrets, SecretOperation, SecretPair } from "../../../domain/context";
import type { ConsumerConfigValues } from "../../../domain/component";
import type { PeakHours } from "../../../domain/peak-hours";
import type { AnswerMap } from "../../../domain/entities/run-form";
import {
  AuthenticationError,
  ConcordError,
  EventNotFoundError,
  EventNotReplayableError,
  RunNotFoundError,
  RunNotAbortableError,
  RunNotRestartableError,
  ConsumerDisabledError,
  ProducerNotFoundError,
  ProducerNotDisableableError,
  ConsumerNotFoundError,
  ContextNotFoundError,
  ContextAlreadyExistsError,
  InvalidPeakHoursError,
  InvalidConsumerConfigError,
  FormNotFoundError,
  FormAlreadyAnsweredError,
  RunNotPendingInputError,
  InvalidFormAnswersError,
  InputRoundsExceededError,
  EventTemplateNotFoundError,
  InvalidEventTemplateAnswersError,
} from "../../../domain/exceptions/errors";
import type { Startable } from "../../main/startable";
import type { Closeable } from "../../main/closeable";
import type { StreamBroadcaster } from "./stream-broadcaster";
import type { WidgetRegistry } from "../widgets/widget-registry";
import { WidgetNotFoundError } from "../widgets/widget-not-found-error";
import {
  toEventDto,
  toRunDto,
  toProducerDto,
  toConsumerDto,
  toContextDto,
  toPeakHoursDto,
  toRunFormDto,
  toRunUpdateDto,
  toEventTemplateDto,
  toFieldOptionDto,
  toLogEntryDto,
  toWidgetDescriptorDto,
  successEnvelope,
  errorEnvelope,
  ERROR_BAD_REQUEST,
  ERROR_NOT_FOUND,
  ERROR_FORBIDDEN,
  ERROR_INTERNAL,
  ERROR_CONFLICT,
  ERROR_UNAUTHORIZED,
} from "./api-dtos";

export interface HttpApiServerAddress {
  readonly host: string;
  readonly port: number;
}

interface ParsedQuery {
  readonly limit: number;
  readonly offset: number;
}

interface QueryParseError {
  readonly error: string;
}

interface PatchBodyResult {
  readonly enabled: boolean;
}

interface PatchBodyError {
  readonly error: string;
}

interface CreateContextBody {
  readonly name: string;
  readonly payload: unknown;
  readonly secrets: readonly SecretPair[];
}

interface UpdateContextBody {
  readonly payload: unknown;
  readonly secrets: SecretOperation;
}

interface InitLoginBody {
  readonly username: string;
  readonly clientPublicEphemeral: string;
}

interface VerifyLoginBody {
  readonly handshakeId: string;
  readonly clientPublicEphemeral: string;
  readonly clientSessionProof: string;
}

interface EmitEventBody {
  readonly type: string;
  readonly payload: unknown;
  readonly producerId: string;
}

interface PauseStateBody {
  readonly paused: boolean;
}

type JsonBodyResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

const DEFAULT_LIMIT = 50;
const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const STREAM_PATH = "/api/stream";

const STATIC_MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".webp": "image/webp",
};

export class HttpApiServer implements Startable, Closeable {
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;

  public constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly eventStore: EventStore,
    private readonly runRepository: RunRepository,
    private readonly broadcaster: StreamBroadcaster,
    private readonly listProducers: ListProducers | null = null,
    private readonly listConsumers: ListConsumers | null = null,
    private readonly setProducerEnabled: SetProducerEnabled | null = null,
    private readonly setConsumerEnabled: SetConsumerEnabled | null = null,
    private readonly createContext: CreateContext | null = null,
    private readonly updateContext: UpdateContext | null = null,
    private readonly deleteContext: DeleteContext | null = null,
    private readonly listContexts: ListContexts | null = null,
    private readonly beginLogin: BeginLogin | null = null,
    private readonly completeLogin: CompleteLogin | null = null,
    private readonly authenticateRequest: AuthenticateRequest | null = null,
    private readonly emitEvent: EmitEvent | null = null,
    private readonly getPauseState: GetPauseState | null = null,
    private readonly setPauseState: SetPauseState | null = null,
    private readonly replayEvent: ReplayEvent | null = null,
    private readonly abortRun: AbortRun | null = null,
    private readonly restartRun: RestartRun | null = null,
    private readonly getPeakHours: GetPeakHours | null = null,
    private readonly setPeakHours: SetPeakHours | null = null,
    private readonly setConsumerWaitForOffPeak: SetConsumerWaitForOffPeak | null = null,
    private readonly setConsumerConfig: SetConsumerConfig | null = null,
    private readonly setConsumerSecrets: SetConsumerSecrets | null = null,
    private readonly submitRunInput: SubmitRunInput | null = null,
    private readonly formRepository: FormRepository | null = null,
    private readonly runUpdateRepository: RunUpdateRepository | null = null,
    private readonly listEventTemplates: ListEventTemplates | null = null,
    private readonly emitEventTemplate: EmitEventTemplate | null = null,
    private readonly resolveEventTemplateFieldOptions: ResolveEventTemplateFieldOptions | null = null,
    private readonly queryLogs: QueryLogs | null = null,
    private readonly logStore: LogStore | null = null,
    private readonly uiDir: string | null = null,
    private readonly widgetRegistry: WidgetRegistry | null = null,
  ) {}

  public async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch((cause) => {
        this.writeError(res, 500, ERROR_INTERNAL, this.describe(cause));
      });
    });
    this.wss = new WebSocketServer({ noServer: true });
    this.server.on("upgrade", (req, socket, head) => {
      this.handleUpgrade(req, socket, head);
    });
    await new Promise<void>((resolve) => {
      this.server!.listen(this.port, this.host, () => resolve());
    });
  }

  public async close(): Promise<void> {
    const server = this.server;
    const wss = this.wss;
    this.server = null;
    this.wss = null;
    if (wss !== null) {
      for (const client of wss.clients) {
        client.terminate();
      }
      wss.close();
    }
    if (server !== null) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  }

  public get address(): HttpApiServerAddress | null {
    if (this.server === null) {
      return null;
    }
    const addr = this.server.address();
    if (typeof addr === "string" || addr === null) {
      return null;
    }
    return { host: addr.address, port: addr.port };
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const method = req.method ?? "";
    const parsedUrl = new URL(req.url ?? "/", "http://localhost");
    const segments = parsedUrl.pathname.split("/").filter((segment) => segment.length > 0);

    if (!ALLOWED_METHODS.has(method)) {
      this.writeError(res, 404, ERROR_NOT_FOUND, `No handler for ${method} ${parsedUrl.pathname}`);
      return;
    }

    if (this.isPublicLoginRoute(method, segments)) {
      await this.handleLoginRoute(res, req, method, segments);
      return;
    }

    if (segments.length === 0 || segments[0] !== "api") {
      if (method === "GET" && this.uiDir !== null) {
        return this.serveStaticUi(res, parsedUrl.pathname);
      }
      this.writeError(res, 404, ERROR_NOT_FOUND, `No handler for ${method} ${parsedUrl.pathname}`);
      return;
    }

    if (this.authenticateRequest !== null) {
      const authResult = await this.authenticateHttpRequest(req, res, method, parsedUrl.pathname);
      if (!authResult.authenticated) {
        return;
      }
    }

    if (method === "GET" && segments.length === 2 && segments[1] === "events") {
      await this.handleListEvents(res, parsedUrl.searchParams);
      return;
    }
    if (method === "GET" && segments.length === 3 && segments[1] === "events") {
      await this.handleGetEvent(res, segments[2]);
      return;
    }
    if (
      method === "GET" &&
      segments.length === 4 &&
      segments[1] === "events" &&
      segments[3] === "runs"
    ) {
      await this.handleListRunsByEvent(res, segments[2], parsedUrl.searchParams);
      return;
    }
    if (method === "GET" && segments.length === 2 && segments[1] === "runs") {
      await this.handleListRuns(res, parsedUrl.searchParams);
      return;
    }
    if (method === "GET" && segments.length === 3 && segments[1] === "runs") {
      await this.handleGetRun(res, segments[2]);
      return;
    }
    if (method === "GET" && segments.length === 2 && segments[1] === "producers") {
      await this.handleListProducers(res);
      return;
    }
    if (method === "GET" && segments.length === 2 && segments[1] === "consumers") {
      await this.handleListConsumers(res);
      return;
    }
    if (method === "GET" && segments.length === 2 && segments[1] === "contexts") {
      await this.handleListContexts(res, parsedUrl.searchParams);
      return;
    }
    if (method === "POST" && segments.length === 2 && segments[1] === "contexts") {
      await this.handleCreateContext(res, req);
      return;
    }
    if (method === "PUT" && segments.length === 3 && segments[1] === "contexts") {
      await this.handleUpdateContext(res, req, decodeURIComponent(segments[2]));
      return;
    }
    if (method === "DELETE" && segments.length === 3 && segments[1] === "contexts") {
      await this.handleDeleteContext(res, decodeURIComponent(segments[2]));
      return;
    }
    if (method === "PATCH" && segments.length === 3 && segments[1] === "producers") {
      await this.handlePatchProducer(res, req, segments[2]);
      return;
    }
    if (method === "PATCH" && segments.length === 3 && segments[1] === "consumers") {
      await this.handlePatchConsumer(res, req, segments[2]);
      return;
    }
    if (method === "POST" && segments.length === 2 && segments[1] === "events") {
      await this.handleEmitEvent(res, req);
      return;
    }
    if (method === "GET" && segments.length === 2 && segments[1] === "event-templates") {
      await this.handleListEventTemplates(res);
      return;
    }
    if (
      method === "POST" &&
      segments.length === 4 &&
      segments[1] === "event-templates" &&
      segments[3] === "emit"
    ) {
      await this.handleEmitEventTemplate(res, req, decodeURIComponent(segments[2]));
      return;
    }
    if (
      method === "POST" &&
      segments.length === 4 &&
      segments[1] === "event-templates" &&
      segments[3] === "options"
    ) {
      await this.handleResolveEventTemplateFieldOptions(res, req, decodeURIComponent(segments[2]));
      return;
    }
    if (method === "GET" && segments.length === 2 && segments[1] === "pause") {
      await this.handleGetPauseState(res);
      return;
    }
    if (method === "PUT" && segments.length === 2 && segments[1] === "pause") {
      await this.handleSetPauseState(res, req);
      return;
    }
    if (
      method === "POST" &&
      segments.length === 4 &&
      segments[1] === "events" &&
      segments[3] === "replay"
    ) {
      await this.handleReplayEvent(res, segments[2]);
      return;
    }
    if (
      method === "POST" &&
      segments.length === 4 &&
      segments[1] === "runs" &&
      segments[3] === "abort"
    ) {
      await this.handleAbortRun(res, segments[2]);
      return;
    }
    if (
      method === "POST" &&
      segments.length === 4 &&
      segments[1] === "runs" &&
      segments[3] === "restart"
    ) {
      await this.handleRestartRun(res, segments[2]);
      return;
    }
    if (
      method === "GET" &&
      segments.length === 4 &&
      segments[1] === "runs" &&
      segments[3] === "forms"
    ) {
      await this.handleListRunForms(res, segments[2]);
      return;
    }
    if (
      method === "GET" &&
      segments.length === 4 &&
      segments[1] === "runs" &&
      segments[3] === "updates"
    ) {
      await this.handleListRunUpdates(res, segments[2]);
      return;
    }
    if (
      method === "POST" &&
      segments.length === 6 &&
      segments[1] === "runs" &&
      segments[3] === "forms" &&
      segments[5] === "submit"
    ) {
      await this.handleSubmitRunForm(res, req, segments[2], segments[4]);
      return;
    }
    if (method === "GET" && segments.length === 2 && segments[1] === "peak-hours") {
      await this.handleGetPeakHours(res);
      return;
    }
    if (method === "PUT" && segments.length === 2 && segments[1] === "peak-hours") {
      await this.handleSetPeakHours(res, req);
      return;
    }
    if (
      method === "PUT" &&
      segments.length === 4 &&
      segments[1] === "consumers" &&
      segments[3] === "wait-for-off-peak"
    ) {
      await this.handleSetConsumerWaitForOffPeak(res, req, decodeURIComponent(segments[2]));
      return;
    }
    if (
      method === "PUT" &&
      segments.length === 4 &&
      segments[1] === "consumers" &&
      segments[3] === "config"
    ) {
      await this.handleSetConsumerConfig(res, req, decodeURIComponent(segments[2]));
      return;
    }
    if (
      method === "PUT" &&
      segments.length === 4 &&
      segments[1] === "consumers" &&
      segments[3] === "secrets"
    ) {
      await this.handleSetConsumerSecrets(res, req, decodeURIComponent(segments[2]));
      return;
    }
    if (method === "GET" && segments.length === 2 && segments[1] === "logs") {
      await this.handleQueryLogs(res, parsedUrl.searchParams);
      return;
    }
    if (method === "GET" && segments.length === 3 && segments[1] === "logs" && segments[2] === "sources") {
      await this.handleListLogSources(res);
      return;
    }
    if (method === "GET" && segments.length === 3 && segments[1] === "logs" && segments[2] === "levels") {
      await this.handleListLogLevels(res);
      return;
    }
    if (method === "GET" && segments.length === 2 && segments[1] === "widgets") {
      await this.handleListWidgets(res);
      return;
    }
    if (method === "GET" && segments.length === 3 && segments[1] === "widgets") {
      await this.handleRenderWidget(res, decodeURIComponent(segments[2]));
      return;
    }

    this.writeError(res, 404, ERROR_NOT_FOUND, `No handler for ${method} ${parsedUrl.pathname}`);
  }

  private isPublicLoginRoute(method: string, segments: string[]): boolean {
    if (segments.length !== 3 || segments[0] !== "api" || segments[1] !== "auth") {
      return false;
    }
    return (method === "POST" && segments[2] === "init") || (method === "POST" && segments[2] === "verify");
  }

  private async handleLoginRoute(
    res: http.ServerResponse,
    req: http.IncomingMessage,
    method: string,
    segments: string[],
  ): Promise<void> {
    if (segments[2] === "init") {
      await this.handleInitLogin(res, req);
      return;
    }
    if (segments[2] === "verify") {
      await this.handleVerifyLogin(res, req);
      return;
    }
    this.writeError(res, 404, ERROR_NOT_FOUND, `No handler for ${method} /api/auth/${segments[2]}`);
  }

  private async handleInitLogin(res: http.ServerResponse, req: http.IncomingMessage): Promise<void> {
    if (this.beginLogin === null) {
      this.writeError(res, 404, ERROR_NOT_FOUND, "No handler for POST /api/auth/init");
      return;
    }
    const parsed = this.parseInitLoginBody(await this.readJsonBody(req));
    if ("error" in parsed) {
      this.writeError(res, 400, ERROR_BAD_REQUEST, parsed.error);
      return;
    }
    try {
      const result = await this.beginLogin.begin(parsed.username, parsed.clientPublicEphemeral);
      this.writeSuccess(res, 200, result);
    } catch (cause) {
      this.writeDomainError(res, cause);
    }
  }

  private async handleVerifyLogin(res: http.ServerResponse, req: http.IncomingMessage): Promise<void> {
    if (this.completeLogin === null) {
      this.writeError(res, 404, ERROR_NOT_FOUND, "No handler for POST /api/auth/verify");
      return;
    }
    const parsed = this.parseVerifyLoginBody(await this.readJsonBody(req));
    if ("error" in parsed) {
      this.writeError(res, 400, ERROR_BAD_REQUEST, parsed.error);
      return;
    }
    try {
      const result = await this.completeLogin.complete(
        parsed.handshakeId,
        parsed.clientPublicEphemeral,
        parsed.clientSessionProof,
      );
      this.writeSuccess(res, 200, result);
    } catch (cause) {
      if (cause instanceof AuthenticationError) {
        this.writeError(res, 401, ERROR_UNAUTHORIZED, "invalid credentials");
        return;
      }
      this.writeDomainError(res, cause);
    }
  }

  private async authenticateHttpRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    method: string,
    path: string,
  ): Promise<{ authenticated: boolean }> {
    if (this.authenticateRequest === null) {
      return { authenticated: true };
    }
    const body = await this.readBody(req);
    const signed: SignedRequest = {
      method,
      path,
      body,
      session: this.header(req, "x-concord-session"),
      timestamp: this.header(req, "x-concord-timestamp"),
      nonce: this.header(req, "x-concord-nonce"),
      signature: this.header(req, "x-concord-signature"),
    };
    try {
      await this.authenticateRequest.authenticate(signed);
      (req as { __body?: string }).__body = body;
      return { authenticated: true };
    } catch (cause) {
      if (cause instanceof AuthenticationError) {
        this.writeError(res, 401, ERROR_UNAUTHORIZED, "invalid credentials");
        return { authenticated: false };
      }
      this.writeDomainError(res, cause);
      return { authenticated: false };
    }
  }

  private async handleEmitEvent(res: http.ServerResponse, req: http.IncomingMessage): Promise<void> {
    if (this.emitEvent === null) {
      this.writeError(res, 404, ERROR_NOT_FOUND, "No handler for POST /api/events");
      return;
    }
    const parsed = this.parseEmitEventBody(await this.readJsonBody(req));
    if ("error" in parsed) {
      this.writeError(res, 400, ERROR_BAD_REQUEST, parsed.error);
      return;
    }
    try {
      const descriptor = await this.emitEvent.emit(parsed.type, parsed.payload, parsed.producerId);
      this.writeSuccess(res, 200, toEventDtoFromDescriptor(descriptor));
    } catch (cause) {
      this.writeDomainError(res, cause);
    }
  }

  private async handleListEventTemplates(res: http.ServerResponse): Promise<void> {
    if (this.listEventTemplates === null) {
      this.writeError(res, 404, ERROR_NOT_FOUND, "No handler for GET /api/event-templates");
      return;
    }
    const descriptors = await this.listEventTemplates.list();
    this.writeSuccess(res, 200, descriptors.map(toEventTemplateDto));
  }

  private async handleEmitEventTemplate(
    res: http.ServerResponse,
    req: http.IncomingMessage,
    id: string,
  ): Promise<void> {
    if (this.emitEventTemplate === null) {
      this.writeError(res, 404, ERROR_NOT_FOUND, `No handler for POST /api/event-templates/${id}/emit`);
      return;
    }
    const parsed = this.parseSubmitFormBody(await this.readJsonBody(req));
    if ("error" in parsed) {
      this.writeError(res, 400, ERROR_BAD_REQUEST, parsed.error);
      return;
    }
    try {
      const descriptor = await this.emitEventTemplate.emit(id, parsed.answers);
      this.writeSuccess(res, 200, toEventDtoFromDescriptor(descriptor));
    } catch (cause) {
      this.writeDomainError(res, cause);
    }
  }

  private async handleResolveEventTemplateFieldOptions(
    res: http.ServerResponse,
    req: http.IncomingMessage,
    id: string,
  ): Promise<void> {
    if (this.resolveEventTemplateFieldOptions === null) {
      this.writeError(res, 404, ERROR_NOT_FOUND, `No handler for POST /api/event-templates/${id}/options`);
      return;
    }
    const parsed = this.parseFieldOptionsBody(await this.readJsonBody(req));
    if ("error" in parsed) {
      this.writeError(res, 400, ERROR_BAD_REQUEST, parsed.error);
      return;
    }
    try {
      const options = await this.resolveEventTemplateFieldOptions.resolve(id, parsed.fieldKey, parsed.answers);
      this.writeSuccess(res, 200, { items: options.map(toFieldOptionDto) });
    } catch (cause) {
      this.writeDomainError(res, cause);
    }
  }

  private async handleGetPauseState(res: http.ServerResponse): Promise<void> {
    if (this.getPauseState === null) {
      this.writeError(res, 404, ERROR_NOT_FOUND, "No handler for GET /api/pause");
      return;
    }
    const paused = await this.getPauseState.isPaused();
    this.writeSuccess(res, 200, { paused });
  }

  private async handleSetPauseState(res: http.ServerResponse, req: http.IncomingMessage): Promise<void> {
    if (this.setPauseState === null) {
      this.writeError(res, 404, ERROR_NOT_FOUND, "No handler for PUT /api/pause");
      return;
    }
    const parsed = this.parsePauseStateBody(await this.readJsonBody(req));
    if ("error" in parsed) {
      this.writeError(res, 400, ERROR_BAD_REQUEST, parsed.error);
      return;
    }
    await this.setPauseState.setPaused(parsed.paused);
    this.writeSuccess(res, 200, { paused: parsed.paused });
  }

  private async handleReplayEvent(res: http.ServerResponse, id: string): Promise<void> {
    if (this.replayEvent === null) {
      this.writeError(res, 404, ERROR_NOT_FOUND, `No handler for POST /api/events/${id}/replay`);
      return;
    }
    try {
      const event = await this.replayEvent.replay(id);
      this.writeSuccess(res, 200, toEventDto(event));
    } catch (cause) {
      this.writeDomainError(res, cause);
    }
  }

  private async handleAbortRun(res: http.ServerResponse, id: string): Promise<void> {
    if (this.abortRun === null) {
      this.writeError(res, 404, ERROR_NOT_FOUND, `No handler for POST /api/runs/${id}/abort`);
      return;
    }
    try {
      const run = await this.abortRun.abort(id);
      this.writeSuccess(res, 200, toRunDto(run));
    } catch (cause) {
      this.writeDomainError(res, cause);
    }
  }

  private async handleRestartRun(res: http.ServerResponse, id: string): Promise<void> {
    if (this.restartRun === null) {
      this.writeError(res, 404, ERROR_NOT_FOUND, `No handler for POST /api/runs/${id}/restart`);
      return;
    }
    try {
      const run = await this.restartRun.restart(id);
      this.writeSuccess(res, 200, toRunDto(run));
    } catch (cause) {
      this.writeDomainError(res, cause);
    }
  }

  private async handleListRunForms(res: http.ServerResponse, runId: string): Promise<void> {
    if (this.formRepository === null) {
      this.writeError(res, 404, ERROR_NOT_FOUND, `No handler for GET /api/runs/${runId}/forms`);
      return;
    }
    try {
      await this.runRepository.getById(runId);
      const forms = await this.formRepository.listByRun(runId);
      this.writeSuccess(res, 200, { items: forms.map(toRunFormDto) });
    } catch (cause) {
      this.writeDomainError(res, cause);
    }
  }

  private async handleListRunUpdates(res: http.ServerResponse, runId: string): Promise<void> {
    if (this.runUpdateRepository === null) {
      this.writeError(res, 404, ERROR_NOT_FOUND, `No handler for GET /api/runs/${runId}/updates`);
      return;
    }
    try {
      await this.runRepository.getById(runId);
      const updates = await this.runUpdateRepository.listByRun(runId);
      this.writeSuccess(res, 200, { items: updates.map(toRunUpdateDto) });
    } catch (cause) {
      this.writeDomainError(res, cause);
    }
  }

  private async handleSubmitRunForm(
    res: http.ServerResponse,
    req: http.IncomingMessage,
    runId: string,
    formId: string,
  ): Promise<void> {
    if (this.submitRunInput === null) {
      this.writeError(res, 404, ERROR_NOT_FOUND, `No handler for POST /api/runs/${runId}/forms/${formId}/submit`);
      return;
    }
    const parsed = this.parseSubmitFormBody(await this.readJsonBody(req));
    if ("error" in parsed) {
      this.writeError(res, 400, ERROR_BAD_REQUEST, parsed.error);
      return;
    }
    try {
      const form = await this.submitRunInput.submit(runId, formId, parsed.answers);
      this.writeSuccess(res, 200, toRunFormDto(form));
    } catch (cause) {
      this.writeDomainError(res, cause);
    }
  }

  private async handleGetPeakHours(res: http.ServerResponse): Promise<void> {
    if (this.getPeakHours === null) {
      this.writeError(res, 404, ERROR_NOT_FOUND, "No handler for GET /api/peak-hours");
      return;
    }
    const peakHours = await this.getPeakHours.get();
    this.writeSuccess(res, 200, { peakHours: toPeakHoursDto(peakHours) });
  }

  private async handleSetPeakHours(res: http.ServerResponse, req: http.IncomingMessage): Promise<void> {
    if (this.setPeakHours === null) {
      this.writeError(res, 404, ERROR_NOT_FOUND, "No handler for PUT /api/peak-hours");
      return;
    }
    const parsed = this.parsePeakHoursBody(await this.readJsonBody(req));
    if ("error" in parsed) {
      this.writeError(res, 400, ERROR_BAD_REQUEST, parsed.error);
      return;
    }
    try {
      const stored = await this.setPeakHours.set(parsed.value);
      this.writeSuccess(res, 200, { peakHours: toPeakHoursDto(stored) });
    } catch (cause) {
      this.writeDomainError(res, cause);
    }
  }

  private async handleSetConsumerWaitForOffPeak(
    res: http.ServerResponse,
    req: http.IncomingMessage,
    id: string,
  ): Promise<void> {
    if (this.setConsumerWaitForOffPeak === null) {
      this.writeError(res, 404, ERROR_NOT_FOUND, `No handler for PUT /api/consumers/${id}/wait-for-off-peak`);
      return;
    }
    const parsed = this.parseWaitForOffPeakBody(await this.readJsonBody(req));
    if ("error" in parsed) {
      this.writeError(res, 400, ERROR_BAD_REQUEST, parsed.error);
      return;
    }
    try {
      const descriptor = await this.setConsumerWaitForOffPeak.set(id, parsed.waitForOffPeak);
      this.writeSuccess(res, 200, toConsumerDto(descriptor));
    } catch (cause) {
      this.writeDomainError(res, cause);
    }
  }

  private async handleSetConsumerConfig(
    res: http.ServerResponse,
    req: http.IncomingMessage,
    id: string,
  ): Promise<void> {
    if (this.setConsumerConfig === null) {
      this.writeError(res, 404, ERROR_NOT_FOUND, `No handler for PUT /api/consumers/${id}/config`);
      return;
    }
    const parsed = this.parseConsumerConfigBody(await this.readJsonBody(req));
    if ("error" in parsed) {
      this.writeError(res, 400, ERROR_BAD_REQUEST, parsed.error);
      return;
    }
    try {
      const descriptor = await this.setConsumerConfig.set(id, parsed.values);
      this.writeSuccess(res, 200, toConsumerDto(descriptor));
    } catch (cause) {
      this.writeDomainError(res, cause);
    }
  }

  private async handleSetConsumerSecrets(
    res: http.ServerResponse,
    req: http.IncomingMessage,
    id: string,
  ): Promise<void> {
    if (this.setConsumerSecrets === null) {
      this.writeError(res, 404, ERROR_NOT_FOUND, `No handler for PUT /api/consumers/${id}/secrets`);
      return;
    }
    const parsed = this.parseConsumerSecretsBody(await this.readJsonBody(req));
    if ("error" in parsed) {
      this.writeError(res, 400, ERROR_BAD_REQUEST, parsed.error);
      return;
    }
    try {
      const descriptor = await this.setConsumerSecrets.set(id, parsed.operation);
      this.writeSuccess(res, 200, toConsumerDto(descriptor));
    } catch (cause) {
      this.writeDomainError(res, cause);
    }
  }

  private async handleListEvents(res: http.ServerResponse, params: URLSearchParams): Promise<void> {
    const parsed = this.parsePagination(params);
    if ("error" in parsed) {
      this.writeError(res, 400, ERROR_BAD_REQUEST, parsed.error);
      return;
    }
    const result = await this.eventStore.list(parsed);
    const dto = {
      items: result.items.map(toEventDto),
      total: result.total,
      limit: result.limit,
      offset: result.offset,
    };
    this.writeSuccess(res, 200, dto);
  }

  private async handleGetEvent(res: http.ServerResponse, id: string): Promise<void> {
    try {
      const event = await this.eventStore.getById(id);
      this.writeSuccess(res, 200, toEventDto(event));
    } catch (cause) {
      this.writeDomainError(res, cause);
    }
  }

  private async handleListRuns(res: http.ServerResponse, params: URLSearchParams): Promise<void> {
    const parsed = this.parsePagination(params);
    if ("error" in parsed) {
      this.writeError(res, 400, ERROR_BAD_REQUEST, parsed.error);
      return;
    }
    const result = await this.runRepository.list(parsed);
    const dto = {
      items: result.items.map(toRunDto),
      total: result.total,
      limit: result.limit,
      offset: result.offset,
    };
    this.writeSuccess(res, 200, dto);
  }

  private async handleListRunsByEvent(
    res: http.ServerResponse,
    eventId: string,
    params: URLSearchParams,
  ): Promise<void> {
    try {
      await this.eventStore.getById(eventId);
    } catch (cause) {
      this.writeDomainError(res, cause);
      return;
    }
    const parsed = this.parsePagination(params);
    if ("error" in parsed) {
      this.writeError(res, 400, ERROR_BAD_REQUEST, parsed.error);
      return;
    }
    const result = await this.runRepository.listByEventId(eventId, parsed);
    const dto = {
      items: result.items.map(toRunDto),
      total: result.total,
      limit: result.limit,
      offset: result.offset,
    };
    this.writeSuccess(res, 200, dto);
  }

  private async handleGetRun(res: http.ServerResponse, id: string): Promise<void> {
    try {
      const run = await this.runRepository.getById(id);
      this.writeSuccess(res, 200, toRunDto(run));
    } catch (cause) {
      this.writeDomainError(res, cause);
    }
  }

  private async handleListProducers(res: http.ServerResponse): Promise<void> {
    if (this.listProducers === null) {
      this.writeError(res, 404, ERROR_NOT_FOUND, "No handler for GET /api/producers");
      return;
    }
    const descriptors = await this.listProducers.list();
    this.writeSuccess(res, 200, descriptors.map(toProducerDto));
  }

  private async handleListConsumers(res: http.ServerResponse): Promise<void> {
    if (this.listConsumers === null) {
      this.writeError(res, 404, ERROR_NOT_FOUND, "No handler for GET /api/consumers");
      return;
    }
    const descriptors = await this.listConsumers.list();
    this.writeSuccess(res, 200, descriptors.map(toConsumerDto));
  }

  private async handlePatchProducer(
    res: http.ServerResponse,
    req: http.IncomingMessage,
    id: string,
  ): Promise<void> {
    if (this.setProducerEnabled === null) {
      this.writeError(res, 404, ERROR_NOT_FOUND, `No handler for PATCH /api/producers/${id}`);
      return;
    }
    const parsed = await this.parsePatchBody(req);
    if ("error" in parsed) {
      this.writeError(res, 400, ERROR_BAD_REQUEST, parsed.error);
      return;
    }
    try {
      await this.setProducerEnabled.setEnabled(id, parsed.enabled);
      this.writeSuccess(res, 200, { id, enabled: parsed.enabled });
    } catch (cause) {
      this.writeDomainError(res, cause);
    }
  }

  private async handlePatchConsumer(
    res: http.ServerResponse,
    req: http.IncomingMessage,
    id: string,
  ): Promise<void> {
    if (this.setConsumerEnabled === null) {
      this.writeError(res, 404, ERROR_NOT_FOUND, `No handler for PATCH /api/consumers/${id}`);
      return;
    }
    const parsed = await this.parsePatchBody(req);
    if ("error" in parsed) {
      this.writeError(res, 400, ERROR_BAD_REQUEST, parsed.error);
      return;
    }
    try {
      await this.setConsumerEnabled.setEnabled(id, parsed.enabled);
      this.writeSuccess(res, 200, { id, enabled: parsed.enabled });
    } catch (cause) {
      this.writeDomainError(res, cause);
    }
  }

  private async handleListContexts(res: http.ServerResponse, params: URLSearchParams): Promise<void> {
    if (this.listContexts === null) {
      this.writeError(res, 404, ERROR_NOT_FOUND, "No handler for GET /api/contexts");
      return;
    }
    const parsed = this.parsePagination(params);
    if ("error" in parsed) {
      this.writeError(res, 400, ERROR_BAD_REQUEST, parsed.error);
      return;
    }
    try {
      const result = await this.listContexts.list(parsed);
      const dto = {
        items: result.items.map(toContextDto),
        total: result.total,
        limit: result.limit,
        offset: result.offset,
      };
      this.writeSuccess(res, 200, dto);
    } catch (cause) {
      this.writeDomainError(res, cause);
    }
  }

  private async handleCreateContext(res: http.ServerResponse, req: http.IncomingMessage): Promise<void> {
    if (this.createContext === null) {
      this.writeError(res, 404, ERROR_NOT_FOUND, "No handler for POST /api/contexts");
      return;
    }
    const parsed = this.parseCreateContextBody(await this.readJsonBody(req));
    if ("error" in parsed) {
      this.writeError(res, 400, ERROR_BAD_REQUEST, parsed.error);
      return;
    }
    try {
      const secretsMap = pairsToSecrets(parsed.secrets);
      const descriptor = await this.createContext.create(parsed.name, parsed.payload, secretsMap);
      this.writeSuccess(res, 200, toContextDto(descriptor));
    } catch (cause) {
      this.writeDomainError(res, cause);
    }
  }

  private async handleUpdateContext(
    res: http.ServerResponse,
    req: http.IncomingMessage,
    name: string,
  ): Promise<void> {
    if (this.updateContext === null) {
      this.writeError(res, 404, ERROR_NOT_FOUND, `No handler for PUT /api/contexts/${name}`);
      return;
    }
    const parsed = this.parseUpdateContextBody(await this.readJsonBody(req));
    if ("error" in parsed) {
      this.writeError(res, 400, ERROR_BAD_REQUEST, parsed.error);
      return;
    }
    try {
      const descriptor = await this.updateContext.update(name, parsed.payload, parsed.secrets);
      this.writeSuccess(res, 200, toContextDto(descriptor));
    } catch (cause) {
      this.writeDomainError(res, cause);
    }
  }

  private async handleDeleteContext(res: http.ServerResponse, name: string): Promise<void> {
    if (this.deleteContext === null) {
      this.writeError(res, 404, ERROR_NOT_FOUND, `No handler for DELETE /api/contexts/${name}`);
      return;
    }
    try {
      await this.deleteContext.delete(name);
      this.writeSuccess(res, 200, { name });
    } catch (cause) {
      this.writeDomainError(res, cause);
    }
  }

  private static readonly VALID_LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

  private async handleQueryLogs(res: http.ServerResponse, params: URLSearchParams): Promise<void> {
    if (this.queryLogs === null) {
      this.writeError(res, 404, ERROR_NOT_FOUND, "No handler for GET /api/logs");
      return;
    }
    const pagination = this.parsePagination(params);
    if ("error" in pagination) {
      this.writeError(res, 400, ERROR_BAD_REQUEST, pagination.error);
      return;
    }

    const levelParam = params.get("level");
    let level: LogLevel | undefined;
    if (levelParam !== null) {
      if (!HttpApiServer.VALID_LOG_LEVELS.includes(levelParam as LogLevel)) {
        this.writeError(res, 400, ERROR_BAD_REQUEST, `level must be one of debug, info, warn, error, got: ${levelParam}`);
        return;
      }
      level = levelParam as LogLevel;
    }

    const sourceParam = params.get("source");
    const source = sourceParam !== null ? sourceParam : undefined;

    const textParam = params.get("text");
    const text = textParam !== null ? textParam : undefined;

    const startTimeParam = params.get("startTime");
    let startTime: string | undefined;
    if (startTimeParam !== null) {
      if (Number.isNaN(Date.parse(startTimeParam))) {
        this.writeError(res, 400, ERROR_BAD_REQUEST, `startTime must be a valid ISO 8601 timestamp, got: ${startTimeParam}`);
        return;
      }
      startTime = startTimeParam;
    }

    const endTimeParam = params.get("endTime");
    let endTime: string | undefined;
    if (endTimeParam !== null) {
      if (Number.isNaN(Date.parse(endTimeParam))) {
        this.writeError(res, 400, ERROR_BAD_REQUEST, `endTime must be a valid ISO 8601 timestamp, got: ${endTimeParam}`);
        return;
      }
      endTime = endTimeParam;
    }

    const eventIdParam = params.get("eventId");
    const eventId = eventIdParam !== null ? eventIdParam : undefined;
    const runIdParam = params.get("runId");
    const runId = runIdParam !== null ? runIdParam : undefined;
    const consumerIdParam = params.get("consumerId");
    const consumerId = consumerIdParam !== null ? consumerIdParam : undefined;

    try {
      const result = await this.queryLogs.query({
        limit: pagination.limit,
        offset: pagination.offset,
        level,
        source,
        text,
        startTime,
        endTime,
        eventId,
        runId,
        consumerId,
      });
      this.writeSuccess(res, 200, {
        items: result.items.map(toLogEntryDto),
        total: result.total,
        limit: result.limit,
        offset: result.offset,
      });
    } catch (cause) {
      this.writeDomainError(res, cause);
    }
  }

  private async handleListLogSources(res: http.ServerResponse): Promise<void> {
    if (this.logStore === null) {
      this.writeError(res, 404, ERROR_NOT_FOUND, "No handler for GET /api/logs/sources");
      return;
    }
    try {
      const sources = await this.logStore.distinctSources();
      this.writeSuccess(res, 200, { sources });
    } catch (cause) {
      this.writeDomainError(res, cause);
    }
  }

  private async handleListLogLevels(res: http.ServerResponse): Promise<void> {
    this.writeSuccess(res, 200, { levels: [...HttpApiServer.VALID_LOG_LEVELS] });
  }

  private async handleListWidgets(res: http.ServerResponse): Promise<void> {
    if (this.widgetRegistry === null) {
      this.writeError(res, 404, ERROR_NOT_FOUND, "No handler for GET /api/widgets");
      return;
    }
    const descriptors = this.widgetRegistry.list();
    this.writeSuccess(res, 200, { items: descriptors.map(toWidgetDescriptorDto) });
  }

  private async handleRenderWidget(res: http.ServerResponse, id: string): Promise<void> {
    if (this.widgetRegistry === null) {
      this.writeError(res, 404, ERROR_NOT_FOUND, `No handler for GET /api/widgets/${id}`);
      return;
    }
    try {
      const payload = await this.widgetRegistry.render(id);
      this.writeSuccess(res, 200, payload);
    } catch (cause) {
      if (cause instanceof WidgetNotFoundError) {
        this.writeError(res, 404, ERROR_NOT_FOUND, cause.message);
        return;
      }
      this.writeDomainError(res, cause);
    }
  }

  private parsePagination(params: URLSearchParams): ParsedQuery | QueryParseError {
    const limitParam = params.get("limit");
    const offsetParam = params.get("offset");

    let limit = DEFAULT_LIMIT;
    let offset = 0;

    if (limitParam !== null) {
      if (!/^\d+$/.test(limitParam)) {
        return { error: `limit must be a non-negative integer, got: ${limitParam}` };
      }
      limit = Number(limitParam);
    }

    if (offsetParam !== null) {
      if (!/^\d+$/.test(offsetParam)) {
        return { error: `offset must be a non-negative integer, got: ${offsetParam}` };
      }
      offset = Number(offsetParam);
    }

    return { limit, offset };
  }

  private async parsePatchBody(req: http.IncomingMessage): Promise<PatchBodyResult | PatchBodyError> {
    const json = await this.readJsonBody(req);
    if (!json.ok) {
      return { error: json.error };
    }
    const parsed = json.value;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { error: "Request body must be a JSON object with a boolean 'enabled' field" };
    }
    const obj = parsed as { enabled?: unknown };
    if (typeof obj.enabled !== "boolean") {
      return { error: "Request body must contain a boolean 'enabled' field" };
    }
    return { enabled: obj.enabled };
  }

  private async readJsonBody(req: http.IncomingMessage): Promise<JsonBodyResult<unknown>> {
    const cached = (req as { __body?: string }).__body;
    if (cached !== undefined) {
      return this.parseJson(cached);
    }
    const text = await this.readBodyFromRequest(req);
    return this.parseJson(text);
  }

  private parseJson(text: string): JsonBodyResult<unknown> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, error: "Request body must be valid JSON" };
    }
    return { ok: true, value: parsed };
  }

  private parseCreateContextBody(json: JsonBodyResult<unknown>): CreateContextBody | PatchBodyError {
    if (!json.ok) {
      return { error: json.error };
    }
    const parsed = json.value;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { error: "Request body must be a JSON object with string 'name' and object 'payload' fields" };
    }
    const obj = parsed as { name?: unknown; payload?: unknown; secrets?: unknown };
    if (typeof obj.name !== "string") {
      return { error: "Request body must contain a string 'name' field" };
    }
    if (obj.payload === null || typeof obj.payload !== "object" || Array.isArray(obj.payload)) {
      return { error: "Request body must contain an object 'payload' field" };
    }
    const secrets = parseSecretPairs(obj.secrets);
    if (secrets === null) {
      return { error: "Request body must contain a 'secrets' array of { name, value } string pairs with unique names" };
    }
    return { name: obj.name, payload: obj.payload, secrets };
  }

  private parseUpdateContextBody(json: JsonBodyResult<unknown>): UpdateContextBody | PatchBodyError {
    if (!json.ok) {
      return { error: json.error };
    }
    const parsed = json.value;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { error: "Request body must be a JSON object with an object 'payload' field" };
    }
    const obj = parsed as { payload?: unknown; secrets?: unknown };
    if (obj.payload === null || typeof obj.payload !== "object" || Array.isArray(obj.payload)) {
      return { error: "Request body must contain an object 'payload' field" };
    }
    const secrets = parseSecretOperation(obj.secrets);
    if (secrets === null) {
      return { error: "Request body must contain a 'secrets' object with 'upserts' and 'deletes' arrays" };
    }
    return { payload: obj.payload, secrets };
  }

  private parseInitLoginBody(json: JsonBodyResult<unknown>): InitLoginBody | PatchBodyError {
    if (!json.ok) {
      return { error: json.error };
    }
    const parsed = json.value;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { error: "Request body must be a JSON object with 'username' and 'clientPublicEphemeral' string fields" };
    }
    const obj = parsed as { username?: unknown; clientPublicEphemeral?: unknown };
    if (typeof obj.username !== "string") {
      return { error: "Request body must contain a string 'username' field" };
    }
    if (typeof obj.clientPublicEphemeral !== "string") {
      return { error: "Request body must contain a string 'clientPublicEphemeral' field" };
    }
    return { username: obj.username, clientPublicEphemeral: obj.clientPublicEphemeral };
  }

  private parseVerifyLoginBody(json: JsonBodyResult<unknown>): VerifyLoginBody | PatchBodyError {
    if (!json.ok) {
      return { error: json.error };
    }
    const parsed = json.value;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { error: "Request body must be a JSON object with 'handshakeId', 'clientPublicEphemeral', and 'clientSessionProof' string fields" };
    }
    const obj = parsed as { handshakeId?: unknown; clientPublicEphemeral?: unknown; clientSessionProof?: unknown };
    if (typeof obj.handshakeId !== "string") {
      return { error: "Request body must contain a string 'handshakeId' field" };
    }
    if (typeof obj.clientPublicEphemeral !== "string") {
      return { error: "Request body must contain a string 'clientPublicEphemeral' field" };
    }
    if (typeof obj.clientSessionProof !== "string") {
      return { error: "Request body must contain a string 'clientSessionProof' field" };
    }
    return {
      handshakeId: obj.handshakeId,
      clientPublicEphemeral: obj.clientPublicEphemeral,
      clientSessionProof: obj.clientSessionProof,
    };
  }

  private parseEmitEventBody(json: JsonBodyResult<unknown>): EmitEventBody | PatchBodyError {
    if (!json.ok) {
      return { error: json.error };
    }
    const parsed = json.value;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { error: "Request body must be a JSON object with 'type', 'payload', and 'producerId' fields" };
    }
    const obj = parsed as { type?: unknown; payload?: unknown; producerId?: unknown };
    if (typeof obj.type !== "string") {
      return { error: "Request body must contain a string 'type' field" };
    }
    if (obj.payload === null || typeof obj.payload !== "object" || Array.isArray(obj.payload)) {
      return { error: "Request body must contain an object 'payload' field" };
    }
    if (typeof obj.producerId !== "string") {
      return { error: "Request body must contain a string 'producerId' field" };
    }
    return { type: obj.type, payload: obj.payload, producerId: obj.producerId };
  }

  private parsePauseStateBody(json: JsonBodyResult<unknown>): PauseStateBody | PatchBodyError {
    if (!json.ok) {
      return { error: json.error };
    }
    const parsed = json.value;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { error: "Request body must be a JSON object with a boolean 'paused' field" };
    }
    const obj = parsed as { paused?: unknown };
    if (typeof obj.paused !== "boolean") {
      return { error: "Request body must contain a boolean 'paused' field" };
    }
    return { paused: obj.paused };
  }

  private parsePeakHoursBody(json: JsonBodyResult<unknown>): { readonly value: PeakHours | null } | PatchBodyError {
    if (!json.ok) {
      return { error: json.error };
    }
    const parsed = json.value;
    if (parsed === null) {
      return { value: null };
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { error: "Request body must be null or a JSON object with 'start', 'end', and 'timezone' string fields" };
    }
    const obj = parsed as { start?: unknown; end?: unknown; timezone?: unknown };
    if (typeof obj.start !== "string") {
      return { error: "Request body must contain a string 'start' field" };
    }
    if (typeof obj.end !== "string") {
      return { error: "Request body must contain a string 'end' field" };
    }
    if (typeof obj.timezone !== "string") {
      return { error: "Request body must contain a string 'timezone' field" };
    }
    const startError = validateHHMM("start", obj.start);
    if (startError !== null) {
      return { error: startError };
    }
    const endError = validateHHMM("end", obj.end);
    if (endError !== null) {
      return { error: endError };
    }
    if (!isValidTimezone(obj.timezone)) {
      return { error: `Timezone "${obj.timezone}" is not a valid IANA timezone` };
    }
    return { value: { start: obj.start, end: obj.end, timezone: obj.timezone } };
  }

  private parseWaitForOffPeakBody(json: JsonBodyResult<unknown>): { readonly waitForOffPeak: boolean } | PatchBodyError {
    if (!json.ok) {
      return { error: json.error };
    }
    const parsed = json.value;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { error: "Request body must be a JSON object with a boolean 'waitForOffPeak' field" };
    }
    const obj = parsed as { waitForOffPeak?: unknown };
    if (typeof obj.waitForOffPeak !== "boolean") {
      return { error: "Request body must contain a boolean 'waitForOffPeak' field" };
    }
    return { waitForOffPeak: obj.waitForOffPeak };
  }

  private parseConsumerConfigBody(json: JsonBodyResult<unknown>): { readonly values: ConsumerConfigValues } | PatchBodyError {
    if (!json.ok) {
      return { error: json.error };
    }
    const parsed = json.value;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { error: "Request body must be a JSON object with a 'values' object field" };
    }
    const obj = parsed as { values?: unknown };
    if (obj.values === null || typeof obj.values !== "object" || Array.isArray(obj.values)) {
      return { error: "Request body must contain an object 'values' field" };
    }
    const entries = Object.entries(obj.values as Record<string, unknown>);
    const values: ConsumerConfigValues = {};
    for (const [key, value] of entries) {
      if (typeof value !== "string") {
        return { error: `Value for key "${key}" must be a string` };
      }
      values[key] = value;
    }
    return { values };
  }

  private parseConsumerSecretsBody(json: JsonBodyResult<unknown>): { readonly operation: SecretOperation } | PatchBodyError {
    if (!json.ok) {
      return { error: json.error };
    }
    const parsed = json.value;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { error: "Request body must be a JSON object with a 'secrets' object field" };
    }
    const obj = parsed as { secrets?: unknown };
    const operation = parseSecretOperation(obj.secrets);
    if (operation === null) {
      return { error: "Request body must contain a 'secrets' object with 'upserts' and 'deletes' arrays" };
    }
    return { operation };
  }

  private parseSubmitFormBody(json: JsonBodyResult<unknown>): { readonly answers: AnswerMap } | PatchBodyError {
    if (!json.ok) {
      return { error: json.error };
    }
    const parsed = json.value;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { error: "Request body must be a JSON object with an 'answers' object field" };
    }
    const obj = parsed as { answers?: unknown };
    if (obj.answers === null || typeof obj.answers !== "object" || Array.isArray(obj.answers)) {
      return { error: "Request body must contain an object 'answers' field" };
    }
    const answers: AnswerMap = {};
    for (const [key, value] of Object.entries(obj.answers as Record<string, unknown>)) {
      if (typeof value === "string") {
        answers[key] = value;
      } else if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
        answers[key] = value;
      } else {
        return { error: `Value for answer "${key}" must be a string or a string array` };
      }
    }
    return { answers };
  }

  private parseFieldOptionsBody(json: JsonBodyResult<unknown>): { readonly fieldKey: string; readonly answers: AnswerMap } | PatchBodyError {
    if (!json.ok) {
      return { error: json.error };
    }
    const parsed = json.value;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { error: "Request body must be a JSON object with 'fieldKey' and 'answers' fields" };
    }
    const obj = parsed as { fieldKey?: unknown; answers?: unknown };
    if (typeof obj.fieldKey !== "string" || obj.fieldKey.length === 0) {
      return { error: "Request body must contain a non-empty string 'fieldKey' field" };
    }
    if (obj.answers === null || typeof obj.answers !== "object" || Array.isArray(obj.answers)) {
      return { error: "Request body must contain an object 'answers' field" };
    }
    const answers: AnswerMap = {};
    for (const [key, value] of Object.entries(obj.answers as Record<string, unknown>)) {
      if (typeof value === "string") {
        answers[key] = value;
      } else if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
        answers[key] = value;
      } else {
        return { error: `Value for answer "${key}" must be a string or a string array` };
      }
    }
    return { fieldKey: obj.fieldKey, answers };
  }

  private header(req: http.IncomingMessage, name: string): string {
    const value = req.headers[name];
    if (Array.isArray(value)) {
      return value[0] ?? "";
    }
    return value ?? "";
  }

  private readBody(req: http.IncomingMessage): Promise<string> {
    return this.readBodyFromRequest(req);
  }

  private readBodyFromRequest(req: http.IncomingMessage): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      req.on("end", () => {
        resolve(Buffer.concat(chunks).toString("utf8"));
      });
      req.on("error", reject);
    });
  }

  private writeDomainError(res: http.ServerResponse, cause: unknown): void {
    if (cause instanceof AuthenticationError) {
      this.writeError(res, 401, ERROR_UNAUTHORIZED, "invalid credentials");
    } else     if (
      cause instanceof EventNotFoundError ||
      cause instanceof RunNotFoundError ||
      cause instanceof ProducerNotFoundError ||
      cause instanceof ConsumerNotFoundError ||
      cause instanceof ContextNotFoundError ||
      cause instanceof FormNotFoundError ||
      cause instanceof EventTemplateNotFoundError
    ) {
      this.writeError(res, 404, ERROR_NOT_FOUND, (cause as ConcordError).message);
    } else if (
      cause instanceof ContextAlreadyExistsError ||
      cause instanceof RunNotAbortableError ||
      cause instanceof RunNotRestartableError ||
      cause instanceof ConsumerDisabledError ||
      cause instanceof FormAlreadyAnsweredError ||
      cause instanceof RunNotPendingInputError
    ) {
      this.writeError(res, 409, ERROR_CONFLICT, cause.message);
    } else if (
      cause instanceof InvalidPeakHoursError ||
      cause instanceof InvalidConsumerConfigError ||
      cause instanceof InvalidFormAnswersError ||
      cause instanceof InputRoundsExceededError ||
      cause instanceof InvalidEventTemplateAnswersError
    ) {
      this.writeError(res, 400, ERROR_BAD_REQUEST, cause.message);
    } else if (
      cause instanceof ProducerNotDisableableError ||
      cause instanceof EventNotReplayableError
    ) {
      this.writeError(res, 403, ERROR_FORBIDDEN, cause.message);
    } else if (cause instanceof ConcordError) {
      this.writeError(res, 500, ERROR_INTERNAL, cause.message);
    } else {
      this.writeError(res, 500, ERROR_INTERNAL, this.describe(cause));
    }
  }

  private writeSuccess(res: http.ServerResponse, status: number, data: unknown): void {
    this.writeJson(res, status, successEnvelope(data));
  }

  private writeError(res: http.ServerResponse, status: number, code: string, message: string): void {
    this.writeJson(res, status, errorEnvelope(code, message));
  }

  private writeJson(res: http.ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(text);
  }

  private serveStaticUi(res: http.ServerResponse, pathname: string): void {
    if (this.uiDir === null) {
      this.writeError(res, 404, ERROR_NOT_FOUND, "UI not configured");
      return;
    }
    const uiDir = this.uiDir;
    let rel = decodeURIComponent(pathname);
    if (rel === "/" || rel === "") {
      rel = "/index.html";
    }
    const candidate = path.resolve(uiDir, "." + rel);
    if (!candidate.startsWith(path.resolve(uiDir))) {
      this.writeError(res, 403, "FORBIDDEN", "Path traversal");
      return;
    }
    fs.stat(candidate, (err, stat) => {
      if (!err && stat.isFile()) {
        const type = STATIC_MIME_TYPES[path.extname(candidate).toLowerCase()] ?? "application/octet-stream";
        res.writeHead(200, { "Content-Type": type });
        fs.createReadStream(candidate).pipe(res);
        return;
      }
      // SPA fallback
      res.writeHead(200, { "Content-Type": STATIC_MIME_TYPES[".html"] });
      fs.createReadStream(path.join(uiDir, "index.html")).pipe(res);
    });
  }

  private handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    const parsedUrl = new URL(req.url ?? "/", "http://localhost");
    if (parsedUrl.pathname !== STREAM_PATH) {
      socket.destroy();
      return;
    }
    const proceed = () => {
      this.wss!.handleUpgrade(req, socket, head, (ws: WebSocket) => {
        this.broadcaster.addClient(ws);
      });
    };

    if (this.authenticateRequest === null) {
      proceed();
      return;
    }

    const signed: SignedRequest = {
      method: "GET",
      path: STREAM_PATH,
      body: "",
      session: parsedUrl.searchParams.get("session") ?? "",
      timestamp: parsedUrl.searchParams.get("timestamp") ?? "",
      nonce: parsedUrl.searchParams.get("nonce") ?? "",
      signature: parsedUrl.searchParams.get("signature") ?? "",
    };
    this.authenticateRequest
      .authenticate(signed)
      .then(() => {
        proceed();
      })
      .catch(() => {
        socket.destroy();
      });
  }

  private describe(cause: unknown): string {
    if (cause instanceof Error) {
      return cause.message;
    }
    return String(cause);
  }
}

function toEventDtoFromDescriptor(descriptor: {
  readonly id: string;
  readonly producerId: string;
  readonly producerEventId: string;
  readonly datetime: Date;
  readonly type: string;
  readonly payload: unknown;
}) {
  return {
    id: descriptor.id,
    producerId: descriptor.producerId,
    producerEventId: descriptor.producerEventId,
    datetime: descriptor.datetime.toISOString(),
    type: descriptor.type,
    payload: descriptor.payload,
    muted: false,
  };
}

function parseSecretPairs(value: unknown): readonly SecretPair[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const seen = new Set<string>();
  const pairs: SecretPair[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return null;
    }
    const obj = entry as { name?: unknown; value?: unknown };
    if (typeof obj.name !== "string" || obj.name.length === 0 || typeof obj.value !== "string") {
      return null;
    }
    if (seen.has(obj.name)) {
      return null;
    }
    seen.add(obj.name);
    pairs.push({ name: obj.name, value: obj.value });
  }
  return pairs;
}

function parseSecretOperation(value: unknown): SecretOperation | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const obj = value as { upserts?: unknown; deletes?: unknown };
  if (!Array.isArray(obj.upserts) || !Array.isArray(obj.deletes)) {
    return null;
  }
  const upserts = parseSecretPairs(obj.upserts);
  if (upserts === null) {
    return null;
  }
  const deletes: string[] = [];
  for (const entry of obj.deletes) {
    if (typeof entry !== "string") {
      return null;
    }
    deletes.push(entry);
  }
  const upsertNames = new Set(upserts.map((pair) => pair.name));
  if (deletes.some((name) => upsertNames.has(name))) {
    return null;
  }
  return { upserts, deletes };
}

function pairsToSecrets(pairs: readonly SecretPair[]): ContextSecrets {
  const map: ContextSecrets = {};
  for (const pair of pairs) {
    map[pair.name] = pair.value;
  }
  return map;
}

function validateHHMM(field: string, value: string): string | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (match === null) {
    return `Field "${field}" must be in HH:MM 24-hour format, got: ${value}`;
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23) {
    return `Field "${field}" hour must be between 00 and 23, got: ${match[1]}`;
  }
  if (minutes < 0 || minutes > 59) {
    return `Field "${field}" minute must be between 00 and 59, got: ${match[2]}`;
  }
  return null;
}

function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}
