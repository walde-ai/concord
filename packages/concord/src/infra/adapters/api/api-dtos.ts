import type { Event } from "../../../domain/entities/event";
import type { Run, RunFailure, RunState } from "../../../domain/entities/run";
import type {
  FieldDefinition,
  FormStatus,
  RunForm,
  AnswerMap,
} from "../../../domain/entities/run-form";
import type { RunUpdate } from "../../../domain/entities/run-update";
import type { ProducerDescriptor, ConsumerDescriptor, ConsumerConfigParameter, ConsumerConfigSecretParameter, ConsumerConfigValues } from "../../../domain/component";
import type { PeakHours } from "../../../domain/peak-hours";
import type { ContextDescriptor } from "../../../domain/context";
import type { EventTemplateDescriptor, FieldOption } from "../../../domain/event-template";
import type { LogEntry, LogLevel } from "../../../domain/ports/out/logger";
import type { WidgetDescriptor, WidgetRefresh } from "../widgets/widget";

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

export interface ConsumerConfigParameterDto {
  readonly key: string;
  readonly label: string;
  readonly required: boolean;
  readonly defaultValue: string;
}

export interface ConsumerConfigSecretParameterDto {
  readonly key: string;
  readonly label: string;
}

export type ConsumerConfigValuesDto = Record<string, string>;

export interface ConsumerDto {
  readonly id: string;
  readonly enabled: boolean;
  readonly waitForOffPeak: boolean;
  readonly configParameters: readonly ConsumerConfigParameterDto[];
  readonly configValues: ConsumerConfigValuesDto;
  readonly secretParameters: readonly ConsumerConfigSecretParameterDto[];
  readonly secretNames: readonly string[];
}

export interface PeakHoursDto {
  readonly start: string;
  readonly end: string;
  readonly timezone: string;
}

export interface ContextDto {
  readonly name: string;
  readonly payload: unknown;
  readonly secretNames: readonly string[];
}

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

export interface EventTemplateDto {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly producerId: string;
  readonly fields: readonly FieldDefinitionDto[];
}

export interface RunUpdateDto {
  readonly id: string;
  readonly runId: string;
  readonly consumerId: string;
  readonly message: string;
  readonly createdAt: string;
}

export type { LogLevel } from "../../../domain/ports/out/logger";

export type WidgetRefreshDto = WidgetRefresh;

export interface WidgetDescriptorDto {
  readonly id: string;
  readonly kind: string;
  readonly refresh: WidgetRefreshDto;
}

export function toWidgetDescriptorDto(descriptor: WidgetDescriptor): WidgetDescriptorDto {
  return { id: descriptor.id, kind: descriptor.kind, refresh: descriptor.refresh };
}

export interface LogEntryDto {
  readonly timestamp: string;
  readonly level: LogLevel;
  readonly source: string;
  readonly message: string;
  readonly fields?: Record<string, unknown>;
}

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

export const ERROR_BAD_REQUEST = "BAD_REQUEST";
export const ERROR_NOT_FOUND = "NOT_FOUND";
export const ERROR_FORBIDDEN = "FORBIDDEN";
export const ERROR_INTERNAL = "INTERNAL";
export const ERROR_CONFLICT = "CONFLICT";
export const ERROR_UNAUTHORIZED = "UNAUTHORIZED";

export function toEventDto(event: Event<unknown>): EventDto {
  return {
    id: event.id,
    producerId: event.producerId,
    producerEventId: event.producerEventId,
    datetime: event.datetime.toISOString(),
    type: event.type,
    payload: event.payload,
    muted: event.muted,
  };
}

export function toRunDto(run: Run<unknown>): RunDto {
  return {
    id: run.id,
    consumerId: run.consumerId,
    state: run.state,
    failure: toRunFailureDto(run.failure),
    startedAt: run.startedAt === null ? null : run.startedAt.toISOString(),
    finishedAt: run.finishedAt === null ? null : run.finishedAt.toISOString(),
    event: toEventDto(run.event),
  };
}

export function toRunFailureDto(failure: RunFailure | null): RunFailureDto | null {
  if (failure === null) {
    return null;
  }
  return {
    errorName: failure.errorName,
    message: failure.message,
    stack: failure.stack,
  };
}

export function toProducerDto(descriptor: ProducerDescriptor): ProducerDto {
  return { id: descriptor.producerId, enabled: descriptor.enabled, disableable: descriptor.disableable };
}

export function toConsumerConfigParameterDto(parameter: ConsumerConfigParameter): ConsumerConfigParameterDto {
  return { key: parameter.key, label: parameter.label, required: parameter.required, defaultValue: parameter.defaultValue };
}

export function toConsumerConfigSecretParameterDto(parameter: ConsumerConfigSecretParameter): ConsumerConfigSecretParameterDto {
  return { key: parameter.key, label: parameter.label };
}

export function toConsumerDto(descriptor: ConsumerDescriptor): ConsumerDto {
  return {
    id: descriptor.consumerId,
    enabled: descriptor.enabled,
    waitForOffPeak: descriptor.waitForOffPeak,
    configParameters: descriptor.configParameters.map(toConsumerConfigParameterDto),
    configValues: { ...descriptor.configValues },
    secretParameters: descriptor.secretParameters.map(toConsumerConfigSecretParameterDto),
    secretNames: [...descriptor.secretNames],
  };
}

export function toPeakHoursDto(peakHours: PeakHours | null): PeakHoursDto | null {
  if (peakHours === null) {
    return null;
  }
  return { start: peakHours.start, end: peakHours.end, timezone: peakHours.timezone };
}

export function toContextDto(descriptor: ContextDescriptor): ContextDto {
  return {
    name: descriptor.name,
    payload: descriptor.payload,
    secretNames: Object.keys(descriptor.secrets).sort(),
  };
}

export function toFieldDefinitionDto(field: FieldDefinition): FieldDefinitionDto {
  if (field.inputType === "text" || field.inputType === "textarea") {
    const placeholder =
      field.placeholder !== undefined ? { placeholder: field.placeholder } : {};
    return {
      key: field.key,
      label: field.label,
      inputType: field.inputType,
      defaultValue: field.defaultValue,
      ...placeholder,
    };
  }
  if (field.inputType === "select" && "dynamic" in field && field.dynamic === true) {
    return {
      key: field.key,
      label: field.label,
      inputType: "select",
      dynamic: true,
      dependsOn: field.dependsOn,
      allowOther: field.allowOther,
      defaultValue: field.defaultValue,
    };
  }
  if ("options" in field) {
    return {
      key: field.key,
      label: field.label,
      inputType: field.inputType,
      options: [...field.options],
      allowOther: field.allowOther,
      defaultValue: field.defaultValue,
    };
  }
  return {
    key: field.key,
    label: field.label,
    inputType: "text",
    defaultValue: "",
  };
}

export function toRunFormDto(form: RunForm): RunFormDto {
  return {
    id: form.id,
    runId: form.runId,
    consumerId: form.consumerId,
    round: form.round,
    status: form.status,
    prompt: form.prompt,
    context: form.context,
    fields: form.fields.map(toFieldDefinitionDto),
    answers: form.answers === null ? null : cloneAnswers(form.answers),
    createdAt: form.createdAt.toISOString(),
    answeredAt: form.answeredAt === null ? null : form.answeredAt.toISOString(),
  };
}

export function toEventTemplateDto(descriptor: EventTemplateDescriptor): EventTemplateDto {
  return {
    id: descriptor.id,
    label: descriptor.label,
    description: descriptor.description,
    producerId: descriptor.producerId,
    fields: descriptor.fields.map(toFieldDefinitionDto),
  };
}

export function toRunUpdateDto(update: RunUpdate): RunUpdateDto {
  return {
    id: update.id,
    runId: update.runId,
    consumerId: update.consumerId,
    message: update.message,
    createdAt: update.createdAt.toISOString(),
  };
}

export function toFieldOptionDto(option: FieldOption): FieldOptionDto {
  return { value: option.value, label: option.label };
}

export function toLogEntryDto(entry: LogEntry): LogEntryDto {
  const dto: LogEntryDto = {
    timestamp: entry.timestamp,
    level: entry.level,
    source: entry.source,
    message: entry.message,
    ...(entry.fields !== undefined ? { fields: { ...entry.fields } } : {}),
  };
  return dto;
}

function cloneAnswers(answers: AnswerMap): AnswerMapDto {
  const result: AnswerMapDto = {};
  for (const [key, value] of Object.entries(answers)) {
    result[key] = Array.isArray(value) ? [...value] : value;
  }
  return result;
}

export function successEnvelope<T>(data: T): ApiSuccessEnvelope<T> {
  return { ok: true, data };
}

export function errorEnvelope(code: string, message: string): ApiErrorEnvelope {
  return { ok: false, error: { code, message } };
}

export type { ConsumerConfigValues };
