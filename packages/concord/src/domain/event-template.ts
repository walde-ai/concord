import type { FieldDefinition } from "./entities/run-form";

export interface FieldOption {
  readonly value: string;
  readonly label: string;
}

export interface EventTemplateDescriptor {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly producerId: string;
  readonly fields: readonly FieldDefinition[];
}

export interface EventTemplateEmission {
  readonly type: string;
  readonly payload: unknown;
  readonly producerEventId: string;
}
