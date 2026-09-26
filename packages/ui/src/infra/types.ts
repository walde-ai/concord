export type RunState = "NOT_STARTED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "ABORTED" | "TIMED_OUT" | "WAIT_FOR_OFFPEAK" | "PENDING_INPUT" | "SUPERSEDED";

export interface PauseStateDto {
  readonly paused: boolean;
}

export interface PeakHoursDto {
  readonly start: string;
  readonly end: string;
  readonly timezone: string;
}

export interface EventDto {
  readonly id: string;
  readonly producerId: string;
  readonly producerEventId: string;
  readonly datetime: string;
  readonly type: string;
  readonly payload: unknown;
  readonly muted: boolean;
}

export interface RunFailureDto {
  readonly errorName: string;
  readonly message: string;
  readonly stack: string | null;
}

export interface RunActivityFrame {
  readonly runId: string;
  readonly consumerId: string;
  readonly sessionId: string;
  readonly kind: string;
  readonly payload: Record<string, unknown>;
  readonly at: string;
}

export interface RunDto {
  readonly id: string;
  readonly consumerId: string;
  readonly state: RunState;
  readonly failure: RunFailureDto | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly event: EventDto;
}

export interface ProducerDto {
  readonly id: string;
  readonly enabled: boolean;
  readonly disableable: boolean;
}

export interface ConsumerConfigParameter {
  readonly key: string;
  readonly label: string;
  readonly required: boolean;
  readonly defaultValue: string;
}

export interface ConsumerConfigSecretParameter {
  readonly key: string;
  readonly label: string;
}

export type ConsumerConfigValues = Record<string, string>;

export interface ConsumerDto {
  readonly id: string;
  readonly enabled: boolean;
  readonly waitForOffPeak: boolean;
  readonly configParameters: ConsumerConfigParameter[];
  readonly configValues: ConsumerConfigValues;
  readonly secretParameters: ConsumerConfigSecretParameter[];
  readonly secretNames: string[];
}

export interface ContextDto {
  readonly name: string;
  readonly payload: unknown;
  readonly secretNames: string[];
}

export interface SecretPair {
  readonly name: string;
  readonly value: string;
}

export interface SecretOperation {
  readonly upserts: readonly SecretPair[];
  readonly deletes: readonly string[];
}

export type ConsumerSecretOperation = SecretOperation;

export interface ListResult<T> {
  readonly items: T[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export type ContextListResult = ListResult<ContextDto>;

export interface ApiSuccessEnvelope<T> {
  readonly ok: true;
  readonly data: T;
}

export interface ApiErrorBody {
  readonly code: string;
  readonly message: string;
}

export interface ApiErrorEnvelope {
  readonly ok: false;
  readonly error: ApiErrorBody;
}

export type ApiEnvelope<T> = ApiSuccessEnvelope<T> | ApiErrorEnvelope;

export interface StreamFrame<T = unknown> {
  readonly type: string;
  readonly data: T;
}

export type FormStatus = "PENDING" | "ANSWERED";

export type FieldDefinitionDto =
  | {
      readonly key: string;
      readonly label: string;
      readonly inputType: "checkbox" | "select";
      readonly options: readonly string[];
      readonly allowOther: boolean;
      readonly defaultValue: string[] | string;
    }
  | {
      readonly key: string;
      readonly label: string;
      readonly inputType: "text" | "textarea";
      readonly defaultValue: string;
      readonly placeholder?: string;
    }
  | {
      readonly key: string;
      readonly label: string;
      readonly inputType: "select";
      readonly dynamic: true;
      readonly dependsOn: string;
      readonly allowOther: boolean;
      readonly defaultValue: string;
    };

export interface FieldOptionDto {
  readonly value: string;
  readonly label: string;
}

export type AnswerValueDto = string | string[];

export type AnswerMapDto = Record<string, AnswerValueDto>;

export interface RunFormDto {
  readonly id: string;
  readonly runId: string;
  readonly consumerId: string;
  readonly round: number;
  readonly status: FormStatus;
  readonly prompt: string;
  readonly context: string;
  readonly fields: readonly FieldDefinitionDto[];
  readonly answers: AnswerMapDto | null;
  readonly createdAt: string;
  readonly answeredAt: string | null;
}

export interface RunFormListResult {
  readonly items: RunFormDto[];
}

export interface RunUpdateDto {
  readonly id: string;
  readonly runId: string;
  readonly consumerId: string;
  readonly message: string;
  readonly createdAt: string;
}

export interface RunUpdateListResult {
  readonly items: RunUpdateDto[];
}

export interface EventTemplateDto {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly producerId: string;
  readonly fields: readonly FieldDefinitionDto[];
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntryDto {
  readonly timestamp: string;
  readonly level: LogLevel;
  readonly source: string;
  readonly message: string;
  readonly fields?: Record<string, unknown>;
}

export interface LogQueryResult {
  readonly items: LogEntryDto[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export type WidgetRefresh =
  | { readonly variant: "interval"; readonly intervalMs: number }
  | { readonly variant: "static" };

export interface WidgetPayload {
  readonly kind: string;
}

export interface WidgetDescriptor {
  readonly id: string;
  readonly kind: string;
  readonly refresh: WidgetRefresh;
}

export interface WidgetListResult {
  readonly items: WidgetDescriptor[];
}

export type StatusPanelItemStatus = "failed" | "in-progress" | "success";

export interface StatusPanelItem {
  readonly label: string;
  readonly status: StatusPanelItemStatus;
  /** Absolute or relative URL rendered as a link on the item's row. */
  readonly link?: string;
}

export type StatusPanelState =
  | { readonly kind: "available" }
  | { readonly kind: "errored"; readonly message: string };

export interface StatusPanelPayload extends WidgetPayload {
  readonly kind: "status-panel";
  readonly title: string;
  /** Free-form timestamp line (ISO or preformatted); rendered as-is. */
  readonly timestamp?: string;
  readonly state: StatusPanelState;
  readonly items: readonly StatusPanelItem[];
}
