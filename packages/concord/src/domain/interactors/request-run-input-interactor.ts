import type { Run } from "../entities/run";
import {
  RunForm,
  type AnswerMap,
  type FormDefinition,
  type FieldDefinition,
  type ClosedChoiceFieldDefinition,
  type DynamicSelectFieldDefinition,
} from "../entities/run-form";
import type { RequestRunInput } from "../ports/in/request-run-input";
import type { RunRepository } from "../ports/out/run-repository";
import type { FormRepository } from "../ports/out/form-repository";
import type { RunInputRegistry, RunInputHandle } from "../ports/out/run-input-registry";
import type { RunAbortRegistry } from "../ports/out/run-abort-registry";
import type { RunTimeoutClock } from "../ports/out/run-timeout-clock";
import type { ConsumerConfigResolver } from "../ports/out/consumer-config-resolver";
import type { EventLifecycleObserver } from "../ports/out/event-lifecycle-observer";
import type { IdGenerator } from "../ports/out/id-generator";
import type { Clock } from "../ports/out/clock";
import {
  InputRoundsExceededError,
  InvalidFormAnswersError,
} from "../exceptions/errors";
import {
  RUN_INPUT_REQUESTED,
  type RunInputRequestedPayload,
  type RunInputEventEmitter,
} from "../events/run-input-event";

const MAX_INPUT_ROUNDS_KEY = "maxInputRounds";

export class RequestRunInputInteractor implements RequestRunInput {
  public constructor(
    private readonly runRepository: RunRepository,
    private readonly formRepository: FormRepository,
    private readonly inputRegistry: RunInputRegistry,
    private readonly abortRegistry: RunAbortRegistry,
    private readonly timeoutClock: RunTimeoutClock,
    private readonly configResolver: ConsumerConfigResolver,
    private readonly producer: RunInputEventEmitter,
    private readonly idGenerator: IdGenerator,
    private readonly clock: Clock,
    private readonly observer: EventLifecycleObserver,
  ) {}

  public async request(runId: string, definition: FormDefinition): Promise<AnswerMap> {
    validateDefinition(definition);

    const run = await this.runRepository.getById(runId);
    if (run.state !== "RUNNING") {
      throw new RunNotRunningError(runId, run.state);
    }

    const values = await this.configResolver.resolve(run.consumerId);
    const maxRounds = resolveMaxRounds(values[MAX_INPUT_ROUNDS_KEY]);
    const existing = await this.formRepository.countByRun(runId);
    if (existing >= maxRounds) {
      throw new InputRoundsExceededError(runId, maxRounds);
    }

    const round = existing + 1;
    const now = this.clock.now();
    const formId = this.idGenerator.generate();
    // The form the user sees always ends with a free-text "Extra notes" field,
    // regardless of what the caller requested, so the user can add context or
    // caveats the questions did not anticipate. It is appended after validation
    // (so it can never collide with or invalidate the caller's own fields) and
    // is omitted only when the caller already supplied a field with that key.
    const fields = withExtraNotesField(definition.fields);
    const form = new RunForm(
      formId,
      runId,
      run.consumerId,
      round,
      definition.prompt,
      fields,
      "PENDING",
      null,
      now,
      null,
      definition.context ?? "",
    );
    await this.formRepository.save(form);

    run.markPendingInput(now);
    await this.runRepository.save(run);
    this.observer.runStateChanged(run);

    // Pause the execution-timeout clock for the duration of the input wait so
    // the run's budget measures handler execution, not time spent parked for a
    // human. The dispatcher's pausable timer swaps to its longer input-wait
    // bound while paused, so an unanswered form still eventually times out.
    this.timeoutClock.pause(runId);

    const payload: RunInputRequestedPayload = {
      runId,
      consumerId: run.consumerId,
      formId,
      round,
      prompt: definition.prompt,
      fields,
      context: definition.context,
    };
    await this.producer.emit(
      `${runId}/input/${formId}`,
      RUN_INPUT_REQUESTED,
      payload,
    );

    const handle = createHandle();
    this.inputRegistry.register(runId, handle);

    const abortHandle = this.abortRegistry.lookup(runId);
    if (abortHandle !== null) {
      const signal = abortHandle.controller.signal;
      if (signal.aborted) {
        this.inputRegistry.unregister(runId);
        throw new RunAbortedDuringInputError(runId);
      }
      signal.addEventListener("abort", () => {
        handle.reject(new RunAbortedDuringInputError(runId));
      });
    }

    try {
      const answers = await handle.promise;
      this.timeoutClock.resume(runId);
      run.markRunning(this.clock.now());
      await this.runRepository.save(run);
      this.observer.runStateChanged(run);
      return answers;
    } finally {
      this.inputRegistry.unregister(runId);
    }
  }
}

function resolveMaxRounds(raw: string | undefined): number {
  if (raw === undefined || raw.length === 0) {
    return 0;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return 0;
  }
  return parsed;
}

function createHandle(): RunInputHandle {
  let resolveFn!: (answers: AnswerMap) => void;
  let rejectFn!: (cause: unknown) => void;
  const promise = new Promise<AnswerMap>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  return {
    promise,
    resolve: resolveFn,
    reject: rejectFn,
  };
}

function validateDefinition(definition: FormDefinition): void {
  if (typeof definition.prompt !== "string" || definition.prompt.length === 0) {
    throw new InvalidFormAnswersError("Form prompt must be a non-empty string");
  }
  if (definition.context !== undefined && typeof definition.context !== "string") {
    throw new InvalidFormAnswersError("Form context must be a string when provided");
  }
  if (!Array.isArray(definition.fields) || definition.fields.length === 0) {
    throw new InvalidFormAnswersError("Form must define at least one field");
  }
  const keys = new Set<string>();
  for (const field of definition.fields) {
    if (keys.has(field.key)) {
      throw new InvalidFormAnswersError(`Duplicate field key: ${field.key}`);
    }
    keys.add(field.key);
    validateField(field);
  }
}

// Reserved key for the always-present free-text "Extra notes" field appended to
// every input form. Exported so callers (and the ask_question tool description)
// can stay off it; a caller that already supplies this key keeps its own field.
export const RUN_INPUT_EXTRA_NOTES_KEY = "extraNotes";

function withExtraNotesField(fields: readonly FieldDefinition[]): readonly FieldDefinition[] {
  if (fields.some((field) => field.key === RUN_INPUT_EXTRA_NOTES_KEY)) {
    return fields;
  }
  return [
    ...fields,
    {
      key: RUN_INPUT_EXTRA_NOTES_KEY,
      label: "Extra notes",
      inputType: "textarea",
      defaultValue: "",
      placeholder: "Add any extra context, concerns, or instructions for the agent (optional)",
    },
  ];
}

function validateField(field: FieldDefinition): void {
  if (typeof field.key !== "string" || field.key.length === 0) {
    throw new InvalidFormAnswersError("Field key must be a non-empty string");
  }
  if (typeof field.label !== "string") {
    throw new InvalidFormAnswersError(`Field ${field.key} label must be a string`);
  }
  switch (field.inputType) {
    case "text":
    case "textarea": {
      if (typeof field.defaultValue !== "string") {
        throw new InvalidFormAnswersError(`Field ${field.key} defaultValue must be a string`);
      }
      return;
    }
    case "checkbox": {
      if (!Array.isArray(field.defaultValue) || field.defaultValue.some((v) => typeof v !== "string")) {
        throw new InvalidFormAnswersError(`Field ${field.key} defaultValue must be a string array`);
      }
      validateClosedChoiceOptions(field);
      return;
    }
    case "select": {
      if (typeof field.defaultValue !== "string") {
        throw new InvalidFormAnswersError(`Field ${field.key} defaultValue must be a string`);
      }
      if (isDynamicSelect(field)) {
        validateDynamicSelectField(field);
      } else {
        validateClosedChoiceOptions(field);
      }
      return;
    }
    default: {
      throw new InvalidFormAnswersError("Field has unknown inputType");
    }
  }
}

function validateClosedChoiceOptions(field: ClosedChoiceFieldDefinition): void {
  if (!Array.isArray(field.options) || field.options.length === 0) {
    throw new InvalidFormAnswersError(`Field ${field.key} options must be a non-empty string array`);
  }
  if (field.options.some((v) => typeof v !== "string")) {
    throw new InvalidFormAnswersError(`Field ${field.key} options must all be strings`);
  }
  if (typeof field.allowOther !== "boolean") {
    throw new InvalidFormAnswersError(`Field ${field.key} allowOther must be a boolean`);
  }
}

function isDynamicSelect(field: FieldDefinition): field is DynamicSelectFieldDefinition {
  return field.inputType === "select" && "dynamic" in field && field.dynamic === true;
}

function validateDynamicSelectField(field: DynamicSelectFieldDefinition): void {
  if (typeof field.dependsOn !== "string" || field.dependsOn.length === 0) {
    throw new InvalidFormAnswersError(`Field ${field.key} dependsOn must be a non-empty string`);
  }
  if (typeof field.allowOther !== "boolean") {
    throw new InvalidFormAnswersError(`Field ${field.key} allowOther must be a boolean`);
  }
}

class RunNotRunningError extends Error {
  public constructor(
    public readonly runId: string,
    public readonly state: string,
  ) {
    super(`Run ${runId} is not RUNNING (state=${state})`);
    this.name = "RunNotRunningError";
  }
}

class RunAbortedDuringInputError extends Error {
  public constructor(public readonly runId: string) {
    super(`Run ${runId} was aborted while pending input`);
    this.name = "RunAbortedDuringInputError";
  }
}

export { RunNotRunningError, RunAbortedDuringInputError };
export type { Run };
