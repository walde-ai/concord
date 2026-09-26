import type {
  EventDto,
  RunDto,
  ProducerDto,
  ConsumerDto,
  ContextDto,
  ContextListResult,
  ListResult,
  PauseStateDto,
  PeakHoursDto,
  SecretPair,
  SecretOperation,
  ConsumerSecretOperation,
  ApiEnvelope,
  ApiErrorBody,
  RunFormDto,
  RunFormListResult,
  RunUpdateDto,
  RunUpdateListResult,
  AnswerMapDto,
  EventTemplateDto,
  FieldOptionDto,
  LogEntryDto,
  LogQueryResult,
  LogLevel,
  WidgetDescriptor,
  WidgetListResult,
  WidgetPayload,
} from "./types";
import { signRequest } from "./signing";
import { getSession, refreshSession, notifySessionInvalid } from "./session-holder";

const UNAUTHORIZED_CODE = "UNAUTHORIZED";

export class ApiClientError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

interface PaginationParams {
  readonly limit?: number;
  readonly offset?: number;
}

const JSON_CONTENT_TYPE = "application/json";

export class ApiClient {
  public constructor(private readonly baseUrl = "/api") {}

  public async listEvents(params: PaginationParams = {}): Promise<ListResult<EventDto>> {
    return this.getList<EventDto>("/events", params);
  }

  public async getEvent(id: string): Promise<EventDto> {
    return this.getOne<EventDto>(`/events/${encodeURIComponent(id)}`);
  }

  public async listRuns(params: PaginationParams = {}): Promise<ListResult<RunDto>> {
    return this.getList<RunDto>("/runs", params);
  }

  public async getRun(id: string): Promise<RunDto> {
    return this.getOne<RunDto>(`/runs/${encodeURIComponent(id)}`);
  }

  public async listRunsByEvent(eventId: string, params: PaginationParams = {}): Promise<ListResult<RunDto>> {
    return this.getList<RunDto>(`/events/${encodeURIComponent(eventId)}/runs`, params);
  }

  public async listProducers(): Promise<ProducerDto[]> {
    return this.get<ProducerDto[]>("/producers");
  }

  public async listConsumers(): Promise<ConsumerDto[]> {
    return this.get<ConsumerDto[]>("/consumers");
  }

  public async setProducerEnabled(id: string, enabled: boolean): Promise<ProducerDto> {
    return this.request<ProducerDto>("PATCH", `/producers/${encodeURIComponent(id)}`, { enabled });
  }

  public async setConsumerEnabled(id: string, enabled: boolean): Promise<ConsumerDto> {
    return this.request<ConsumerDto>("PATCH", `/consumers/${encodeURIComponent(id)}`, { enabled });
  }

  public async setConsumerWaitForOffPeak(id: string, waitForOffPeak: boolean): Promise<ConsumerDto> {
    return this.request<ConsumerDto>("PUT", `/consumers/${encodeURIComponent(id)}/wait-for-off-peak`, { waitForOffPeak });
  }

  public async setConsumerConfig(id: string, values: Record<string, string>): Promise<ConsumerDto> {
    return this.request<ConsumerDto>("PUT", `/consumers/${encodeURIComponent(id)}/config`, { values });
  }

  public async setConsumerSecrets(id: string, operation: ConsumerSecretOperation): Promise<ConsumerDto> {
    return this.request<ConsumerDto>("PUT", `/consumers/${encodeURIComponent(id)}/secrets`, { secrets: operation });
  }

  public async getPeakHours(): Promise<{ peakHours: PeakHoursDto | null }> {
    const fullPath = `${this.baseUrl}/peak-hours`;
    return this.send<{ peakHours: PeakHoursDto | null }>("GET", fullPath, fullPath, "", undefined);
  }

  public async setPeakHours(value: PeakHoursDto | null): Promise<{ peakHours: PeakHoursDto | null }> {
    return this.request<{ peakHours: PeakHoursDto | null }>("PUT", "/peak-hours", value);
  }

  public async listContexts(params: PaginationParams = {}): Promise<ContextListResult> {
    return this.getList<ContextDto>("/contexts", params);
  }

  public async createContext(name: string, payload: unknown, secrets: readonly SecretPair[]): Promise<ContextDto> {
    return this.request<ContextDto>("POST", "/contexts", { name, payload, secrets });
  }

  public async updateContext(name: string, payload: unknown, secrets: SecretOperation): Promise<ContextDto> {
    return this.request<ContextDto>("PUT", `/contexts/${encodeURIComponent(name)}`, { payload, secrets });
  }

  public async deleteContext(name: string): Promise<{ name: string }> {
    const fullPath = `${this.baseUrl}/contexts/${encodeURIComponent(name)}`;
    return this.send<{ name: string }>("DELETE", fullPath, fullPath, "", undefined);
  }

  public async getPauseState(): Promise<PauseStateDto> {
    const fullPath = `${this.baseUrl}/pause`;
    return this.send<PauseStateDto>("GET", fullPath, fullPath, "", undefined);
  }

  public async setPauseState(paused: boolean): Promise<PauseStateDto> {
    return this.request<PauseStateDto>("PUT", "/pause", { paused });
  }

  public async replayEvent(id: string): Promise<EventDto> {
    const fullPath = `${this.baseUrl}/events/${encodeURIComponent(id)}/replay`;
    return this.send<EventDto>("POST", fullPath, fullPath, "", undefined);
  }

  public async abortRun(id: string): Promise<RunDto> {
    const fullPath = `${this.baseUrl}/runs/${encodeURIComponent(id)}/abort`;
    return this.send<RunDto>("POST", fullPath, fullPath, "", undefined);
  }

  public async restartRun(id: string): Promise<RunDto> {
    const fullPath = `${this.baseUrl}/runs/${encodeURIComponent(id)}/restart`;
    return this.send<RunDto>("POST", fullPath, fullPath, "", undefined);
  }

  public async listRunForms(runId: string): Promise<RunFormDto[]> {
    const fullPath = `${this.baseUrl}/runs/${encodeURIComponent(runId)}/forms`;
    const result = await this.send<RunFormListResult>("GET", fullPath, fullPath, "", undefined);
    return result.items;
  }

  public async submitRunForm(runId: string, formId: string, answers: AnswerMapDto): Promise<RunFormDto> {
    return this.request<RunFormDto>(
      "POST",
      `/runs/${encodeURIComponent(runId)}/forms/${encodeURIComponent(formId)}/submit`,
      { answers },
    );
  }

  public async listRunUpdates(runId: string): Promise<RunUpdateDto[]> {
    const fullPath = `${this.baseUrl}/runs/${encodeURIComponent(runId)}/updates`;
    const result = await this.send<RunUpdateListResult>("GET", fullPath, fullPath, "", undefined);
    return result.items;
  }

  public async listEventTemplates(): Promise<EventTemplateDto[]> {
    return this.get<EventTemplateDto[]>("/event-templates");
  }

  public async emitEventTemplate(id: string, answers: AnswerMapDto): Promise<EventDto> {
    return this.request<EventDto>(
      "POST",
      `/event-templates/${encodeURIComponent(id)}/emit`,
      { answers },
    );
  }

  public async resolveEventTemplateFieldOptions(id: string, fieldKey: string, answers: AnswerMapDto): Promise<FieldOptionDto[]> {
    const result = await this.request<{ items: FieldOptionDto[] }>(
      "POST",
      `/event-templates/${encodeURIComponent(id)}/options`,
      { fieldKey, answers },
    );
    return result.items;
  }

  public async queryLogs(params: {
    readonly limit?: number;
    readonly offset?: number;
    readonly level?: LogLevel;
    readonly source?: string;
    readonly text?: string;
    readonly startTime?: string;
    readonly endTime?: string;
  } = {}): Promise<LogQueryResult> {
    const search = new URLSearchParams();
    if (params.limit !== undefined) {
      search.set("limit", String(params.limit));
    }
    if (params.offset !== undefined) {
      search.set("offset", String(params.offset));
    }
    if (params.level !== undefined) {
      search.set("level", params.level);
    }
    if (params.source !== undefined) {
      search.set("source", params.source);
    }
    if (params.text !== undefined) {
      search.set("text", params.text);
    }
    if (params.startTime !== undefined) {
      search.set("startTime", params.startTime);
    }
    if (params.endTime !== undefined) {
      search.set("endTime", params.endTime);
    }
    const queryString = search.toString();
    const query = queryString.length > 0 ? `?${queryString}` : "";
    const fullPath = `${this.baseUrl}/logs`;
    return this.send<LogQueryResult>("GET", fullPath, fullPath, query, undefined);
  }

  public async listLogSources(): Promise<string[]> {
    const fullPath = `${this.baseUrl}/logs/sources`;
    const result = await this.send<{ sources: string[] }>("GET", fullPath, fullPath, "", undefined);
    return result.sources;
  }

  public async listWidgets(): Promise<WidgetDescriptor[]> {
    const fullPath = `${this.baseUrl}/widgets`;
    const result = await this.send<WidgetListResult>("GET", fullPath, fullPath, "", undefined);
    return result.items;
  }

  public async getWidget(id: string): Promise<WidgetPayload> {
    const fullPath = `${this.baseUrl}/widgets/${encodeURIComponent(id)}`;
    return this.send<WidgetPayload>("GET", fullPath, fullPath, "", undefined);
  }

  private async getList<T>(path: string, params: PaginationParams): Promise<ListResult<T>> {
    const query = this.buildQuery(params);
    const fullPath = `${this.baseUrl}${path}`;
    return this.send<ListResult<T>>("GET", fullPath, fullPath, query, undefined);
  }

  private async getOne<T>(path: string): Promise<T> {
    const fullPath = `${this.baseUrl}${path}`;
    return this.send<T>("GET", fullPath, fullPath, "", undefined);
  }

  private async get<T>(path: string): Promise<T> {
    const fullPath = `${this.baseUrl}${path}`;
    return this.send<T>("GET", fullPath, fullPath, "", undefined);
  }

  private async request<T>(method: string, path: string, body: unknown): Promise<T> {
    const fullPath = `${this.baseUrl}${path}`;
    return this.send<T>(method, fullPath, fullPath, "", body);
  }

  private async send<T>(
    method: string,
    signPath: string,
    url: string,
    query: string,
    body: unknown,
  ): Promise<T> {
    const bodyText = body === undefined ? "" : JSON.stringify(body);

    const first = await this.dispatch<T>(method, signPath, url, query, body, bodyText);
    if (first.ok) {
      return first.data;
    }
    if (first.error.code === UNAUTHORIZED_CODE) {
      const refreshed = await refreshSession();
      if (refreshed && getSession() !== null) {
        const retry = await this.dispatch<T>(method, signPath, url, query, body, bodyText);
        if (retry.ok) {
          return retry.data;
        }
        notifySessionInvalid();
        throw this.toError(retry.error);
      } else {
        notifySessionInvalid();
        throw this.toError(first.error);
      }
    }
    throw this.toError(first.error);
  }

  private async dispatch<T>(
    method: string,
    signPath: string,
    url: string,
    query: string,
    body: unknown,
    bodyText: string,
  ): Promise<ApiEnvelope<T>> {
    const headers: Record<string, string> = {};
    if (body !== undefined) {
      headers["Content-Type"] = JSON_CONTENT_TYPE;
    }
    if (getSession() !== null) {
      const signed = await signRequest(method, signPath, bodyText);
      Object.assign(headers, signed.headers);
    }
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      init.body = bodyText;
    }
    const response = await fetch(query.length > 0 ? `${url}${query}` : url, init);
    return (await response.json()) as ApiEnvelope<T>;
  }

  private buildQuery(params: PaginationParams): string {
    const search = new URLSearchParams();
    if (params.limit !== undefined) {
      search.set("limit", String(params.limit));
    }
    if (params.offset !== undefined) {
      search.set("offset", String(params.offset));
    }
    const query = search.toString();
    return query.length > 0 ? `?${query}` : "";
  }

  private toError(error: ApiErrorBody): ApiClientError {
    return new ApiClientError(error.code, error.message);
  }
}
