import type { FieldDefinition } from "../entities/run-form";

export const CONCORD_RUN_INPUT_PRODUCER_ID = "concord.run-input";

export const RUN_INPUT_REQUESTED = "run.input_requested";

export interface RunInputRequestedPayload {
  readonly runId: string;
  readonly consumerId: string;
  readonly formId: string;
  readonly round: number;
  readonly prompt: string;
  readonly fields: readonly FieldDefinition[];
  readonly context?: string;
}

/**
 * Domain-side emitter for the run-input producer. The concrete
 * `InlineProducer` constructed in `MakeApp` satisfies this structurally.
 */
export interface RunInputEventEmitter {
  emit(producerEventId: string, type: string, payload: unknown): Promise<void>;
}
