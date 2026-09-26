import { describe, it, expect } from "vitest";

import { Event } from "../src/domain/entities/event";
import { Run } from "../src/domain/entities/run";
import type { AnswerMap, FormDefinition } from "../src/domain/entities/run-form";
import { RequestRunInputInteractor } from "../src/domain/interactors/request-run-input-interactor";
import { SubmitRunInputInteractor } from "../src/domain/interactors/submit-run-input-interactor";
import { AbortRunInteractor } from "../src/domain/interactors/abort-run-interactor";
import { Consumer } from "../src/domain/entities/consumer";
import type { Handler } from "../src/domain/ports/out/handler";
import type { Result } from "../src/domain/result";
import { success } from "../src/domain/result";
import type { EventHandlerError } from "../src/domain/exceptions/errors";
import { InMemoryRunRepository } from "../src/infra/adapters/stores/in-memory-run-repository";
import { InMemoryFormRepository } from "../src/infra/adapters/stores/in-memory-form-repository";
import { InMemoryRunInputRegistry } from "../src/infra/adapters/registry/in-memory-run-input-registry";
import { InMemoryRunAbortRegistry } from "../src/infra/adapters/registry/in-memory-run-abort-registry";
import { InMemoryRunTimeoutClock } from "../src/infra/adapters/registry/in-memory-run-timeout-clock";
import { InMemoryConsumerStateRepository } from "../src/infra/adapters/stores/in-memory-consumer-state-repository";
import { InMemoryConsumerRegistry } from "../src/infra/adapters/registry/in-memory-consumer-registry";
import { NoOpEventLifecycleObserver } from "../src/infra/adapters/api/no-op-event-lifecycle-observer";
import { RunDispatcher } from "../src/domain/interactors/run-dispatcher";
import { NoOpRunCompletionHook } from "../src/domain/ports/out/run-completion-hook";
import { noopLogger } from "../src/domain/ports/out/logger";
import { noopLogContextScope } from "../src/domain/ports/out/log-context";
import { InMemoryPeakHoursRepository } from "../src/infra/adapters/stores/in-memory-peak-hours-repository";
import { SequentialIdGenerator, FixedClock, TypeRule, FixedRunTimeoutResolver, type Clock } from "./helpers";
import { DEFAULT_RUN_TIMEOUT_MS } from "../src/domain/ports/out/run-timeout-resolver";

const NOW = new Date("2026-07-06T08:00:00Z");

// A clock the test can advance across a virtual human-scale wait, so the
// pause/resume accounting of PausableRunTimeout is observable without real
// timers: a parked run's execution budget must survive any park length.
class SteppingClock implements Clock {
  private ms: number;
  public constructor(start: Date) {
    this.ms = start.getTime();
  }
  public now(): Date {
    return new Date(this.ms);
  }
  public advance(deltaMs: number): void {
    this.ms += deltaMs;
  }
}

class RecordingProducer {
  public readonly emissions: unknown[] = [];
  public async emit(_id: string, _type: string, payload: unknown): Promise<void> {
    this.emissions.push(payload);
  }
}

class ConfigResolver {
  public constructor(private readonly values: Record<string, string>) {}
  public async resolve(_id: string): Promise<Record<string, string>> {
    return { ...this.values };
  }
}

async function waitForState(repo: InMemoryRunRepository, runId: string, state: Run<unknown>["state"]): Promise<Run<unknown>> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    const run = await repo.getById(runId);
    if (run.state === state) {
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`run ${runId} never reached ${state}`);
}

async function waitForRunInState(repo: InMemoryRunRepository, state: Run<unknown>["state"]): Promise<Run<unknown>> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    const result = await repo.listByState(state, { limit: 10, offset: 0 });
    if (result.items.length > 0) {
      return result.items[0];
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`no run ever reached ${state}`);
}

class AskQuestionHandler implements Handler<unknown> {
  public readonly answers: AnswerMap[] = [];
  public constructor(
    private readonly requestRunInput: RequestRunInputInteractor,
    private readonly definition: FormDefinition,
  ) {}

  public async handle(run: Run<unknown>, _signal: AbortSignal): Promise<Result<void, EventHandlerError>> {
    const answers = await this.requestRunInput.request(run.id, this.definition);
    this.answers.push(answers);
    return success(undefined);
  }
}

interface Wiring {
  readonly runRepository: InMemoryRunRepository;
  readonly formRepository: InMemoryFormRepository;
  readonly inputRegistry: InMemoryRunInputRegistry;
  readonly requestRunInput: RequestRunInputInteractor;
  readonly submitRunInput: SubmitRunInputInteractor;
  readonly abortRun: AbortRunInteractor;
  readonly dispatcher: RunDispatcher;
  readonly consumer: Consumer<unknown>;
}

function buildWiring(
  maxRounds = "2",
  timeouts: { readonly execTimeoutMs?: number; readonly inputTimeoutMs?: number } = {},
  clockOverride?: Clock,
): Wiring {
  const execTimeoutMs = timeouts.execTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  const inputTimeoutMs = timeouts.inputTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
  const runRepository = new InMemoryRunRepository();
  const formRepository = new InMemoryFormRepository();
  const inputRegistry = new InMemoryRunInputRegistry();
  const abortRegistry = new InMemoryRunAbortRegistry();
  const timeoutClock = new InMemoryRunTimeoutClock();
  const consumerRegistry = new InMemoryConsumerRegistry();
  const consumerStateRepository = new InMemoryConsumerStateRepository();
  const observer = new NoOpEventLifecycleObserver();
  const idGenerator = new SequentialIdGenerator();
  const clock = clockOverride ?? new FixedClock(NOW);
  const producer = new RecordingProducer();
  const requestRunInput = new RequestRunInputInteractor(
    runRepository,
    formRepository,
    inputRegistry,
    abortRegistry,
    timeoutClock,
    new ConfigResolver({ maxInputRounds: maxRounds }) as never,
    producer as never,
    idGenerator,
    clock,
    observer,
  );
  const submitRunInput = new SubmitRunInputInteractor(formRepository, inputRegistry, clock);
  const abortRun = new AbortRunInteractor(runRepository, abortRegistry, observer);
  const dispatcher = new RunDispatcher(
    runRepository,
    idGenerator,
    observer,
    abortRegistry,
    clock,
    new InMemoryPeakHoursRepository(),
    { isPeakAt: () => false, nextOffPeakBoundary: () => null },
    consumerStateRepository,
    consumerRegistry,
    new FixedRunTimeoutResolver(execTimeoutMs),
    timeoutClock,
    noopLogger,
    noopLogContextScope,
    new NoOpRunCompletionHook(),
    inputTimeoutMs,
  );
  const definition: FormDefinition = {
    prompt: "Which plan?",
    fields: [
      { key: "plan", label: "Plan", inputType: "select", options: ["A", "B"], allowOther: false, defaultValue: "A" },
    ],
  };
  const consumer = new Consumer<unknown>(
    "c-1",
    new TypeRule("foo"),
    new AskQuestionHandler(requestRunInput, definition),
    [],
    [],
  );
  consumerRegistry.register(consumer);
  return { runRepository, formRepository, inputRegistry, requestRunInput, submitRunInput, abortRun, dispatcher, consumer };
}

describe("Run input park-and-resume wiring", () => {
  it("parks a dispatched run at PENDING_INPUT and resumes to SUCCEEDED after submission", async () => {
    const wiring = buildWiring("2");
    const event = new Event<unknown>("evt-1", "p-1", "pevt-1", NOW, "foo", {});

    const dispatchPromise = wiring.dispatcher.dispatch(event, wiring.consumer);
    const parked = await waitForRunInState(wiring.runRepository, "PENDING_INPUT");

    const forms = await wiring.formRepository.listByRun(parked.id);
    expect(forms).toHaveLength(1);
    expect(forms[0].status).toBe("PENDING");

    const answered = await wiring.submitRunInput.submit(parked.id, forms[0].id, { plan: "B", extraNotes: "" });
    expect(answered.status).toBe("ANSWERED");

    const finalRun = await dispatchPromise;
    await waitForState(wiring.runRepository, finalRun.id, "SUCCEEDED");
    expect((await wiring.runRepository.getById(parked.id)).state).toBe("SUCCEEDED");
  });

  it("a PENDING_INPUT park longer than the execution budget does not consume it (regression: resume charged the park)", async () => {
    // Regression (2026-08-21, live incident): a run parked for a human
    // decision for 16h died the instant the human answered, because resume()
    // added the entire parked interval to the execution budget. The park
    // must be free; only actual handler execution time counts.
    const clock = new SteppingClock(NOW);
    const wiring = buildWiring("2", { execTimeoutMs: 60_000, inputTimeoutMs: 3_600_000 }, clock);
    const event = new Event<unknown>("evt-1", "p-1", "pevt-1", NOW, "foo", {});

    const dispatchPromise = wiring.dispatcher.dispatch(event, wiring.consumer);
    const parked = await waitForRunInState(wiring.runRepository, "PENDING_INPUT");

    // The human takes 10x the execution budget to answer. While parked, the
    // execution clock must not tick: no timeout fires.
    clock.advance(600_000);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect((await wiring.runRepository.getById(parked.id)).state).toBe("PENDING_INPUT");

    const forms = await wiring.formRepository.listByRun(parked.id);
    await wiring.submitRunInput.submit(parked.id, forms[0].id, { plan: "B", extraNotes: "" });

    // Resume: the run must still have its whole execution budget and finish.
    const finalRun = await dispatchPromise;
    await waitForState(wiring.runRepository, finalRun.id, "SUCCEEDED");
    expect((await wiring.runRepository.getById(parked.id)).state).toBe("SUCCEEDED");
  });

  it("never creates a form when maxInputRounds is zero", async () => {
    const wiring = buildWiring("0");
    const event = new Event<unknown>("evt-1", "p-1", "pevt-1", NOW, "foo", {});

    const dispatchPromise = wiring.dispatcher.dispatch(event, wiring.consumer);
    const run = await dispatchPromise;
    await waitForState(wiring.runRepository, run.id, "FAILED");
    expect(await wiring.formRepository.countByRun(run.id)).toBe(0);
  });

  it("aborts a PENDING_INPUT run to ABORTED", async () => {
    const wiring = buildWiring("2");
    const event = new Event<unknown>("evt-1", "p-1", "pevt-1", NOW, "foo", {});

    const dispatchPromise = wiring.dispatcher.dispatch(event, wiring.consumer);
    const parked = await waitForRunInState(wiring.runRepository, "PENDING_INPUT");

    await wiring.abortRun.abort(parked.id);

    await dispatchPromise;
    await waitForState(wiring.runRepository, parked.id, "ABORTED");
    expect((await wiring.runRepository.getById(parked.id)).state).toBe("ABORTED");
  });

  it("does not consume the execution-timeout budget while parked on PENDING_INPUT", async () => {
    // A 300ms execution budget that is PAUSED while the run waits for input,
    // so parking for 700ms (well past the budget) and then submitting must NOT
    // time out — the run resumes and succeeds. (A wall-clock timeout would have
    // fired at 300ms; the input-wait bound here is large so it never interferes.)
    const wiring = buildWiring("2", { execTimeoutMs: 300, inputTimeoutMs: 20_000 });
    const event = new Event<unknown>("evt-1", "p-1", "pevt-1", NOW, "foo", {});

    const dispatchPromise = wiring.dispatcher.dispatch(event, wiring.consumer);
    const parked = await waitForRunInState(wiring.runRepository, "PENDING_INPUT");

    await new Promise((resolve) => setTimeout(resolve, 700));
    expect((await wiring.runRepository.getById(parked.id)).state).toBe("PENDING_INPUT");

    const forms = await wiring.formRepository.listByRun(parked.id);
    await wiring.submitRunInput.submit(parked.id, forms[0].id, { plan: "A", extraNotes: "" });

    await dispatchPromise;
    await waitForState(wiring.runRepository, parked.id, "SUCCEEDED");
    const finished = await wiring.runRepository.getById(parked.id);
    expect(finished.state).toBe("SUCCEEDED");
    expect(finished.failure).toBeNull();
  });

  it("times out a run that stays PENDING_INPUT past the input-wait bound", async () => {
    // The run is never submitted. The execution budget is large (so only the
    // input-wait bound can fire), and the input-wait bound is 300ms. The run
    // must reach TIMED_OUT with the input-wait message — proving the parked run
    // is still bounded even though the execution clock is paused.
    const wiring = buildWiring("2", { execTimeoutMs: 20_000, inputTimeoutMs: 300 });
    const event = new Event<unknown>("evt-1", "p-1", "pevt-1", NOW, "foo", {});

    const dispatchPromise = wiring.dispatcher.dispatch(event, wiring.consumer);
    const parked = await waitForRunInState(wiring.runRepository, "PENDING_INPUT");

    const finished = await dispatchPromise;
    await waitForState(wiring.runRepository, parked.id, "TIMED_OUT");
    const timed = await wiring.runRepository.getById(parked.id);
    expect(timed.state).toBe("TIMED_OUT");
    expect(timed.failure?.errorName).toBe("RunTimeoutError");
    expect(timed.failure?.message).toContain("waiting");
    expect(finished.state).toBe("TIMED_OUT");
  });
});
