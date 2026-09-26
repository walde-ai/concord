import type { Event } from "../entities/event";
import { Run, RunFailure } from "../entities/run";
import type { Consumer } from "../entities/consumer";
import type { RunRepository } from "../ports/out/run-repository";
import type { IdGenerator } from "../ports/out/id-generator";
import type { Clock } from "../ports/out/clock";
import type { EventLifecycleObserver } from "../ports/out/event-lifecycle-observer";
import type { RunAbortRegistry, AbortHandle } from "../ports/out/run-abort-registry";
import type { PeakHoursRepository } from "../ports/out/peak-hours-repository";
import type { PeakSchedule } from "../ports/out/peak-schedule";
import type { ConsumerStateRepository } from "../ports/out/consumer-state-repository";
import type { ConsumerRegistry } from "../ports/out/consumer-registry";
import type { RunTimeoutResolver } from "../ports/out/run-timeout-resolver";
import { DEFAULT_RUN_INPUT_TIMEOUT_MS } from "../ports/out/run-timeout-resolver";
import type { RunTimeoutClock } from "../ports/out/run-timeout-clock";
import type { Logger } from "../ports/out/logger";
import type {
  FinishedRunDetail,
  FinishedRunRepoRef,
  RunCompletionHook,
  TerminalRunState,
} from "../ports/out/run-completion-hook";
import type { LogContextScope } from "../ports/out/log-context";
import type { Result } from "../result";
import { failure } from "../result";
import type { EventHandlerError } from "../exceptions/errors";
import { UnexpectedHandlerError, RunSupersededError, UnexpectedStateError } from "../exceptions/errors";

export class RunDispatcher {
  private readonly detached: Set<Promise<unknown>> = new Set();

  public constructor(
    private readonly runRepository: RunRepository,
    private readonly idGenerator: IdGenerator,
    private readonly observer: EventLifecycleObserver,
    private readonly abortRegistry: RunAbortRegistry,
    private readonly clock: Clock,
    private readonly peakHoursRepository: PeakHoursRepository,
    private readonly peakSchedule: PeakSchedule,
    private readonly consumerStateRepository: ConsumerStateRepository,
    private readonly consumerRegistry: ConsumerRegistry,
    private readonly timeoutResolver: RunTimeoutResolver,
    private readonly timeoutClock: RunTimeoutClock,
    private readonly logger: Logger,
    private readonly logContextScope: LogContextScope,
    private readonly completionHook: RunCompletionHook,
    private readonly inputTimeoutMs: number = DEFAULT_RUN_INPUT_TIMEOUT_MS,
  ) {}

  public async dispatch(event: Event<unknown>, consumer: Consumer<unknown>): Promise<Run<unknown>> {
    const run = await this.prepareRun(event, consumer);
    if (run.state === "WAIT_FOR_OFFPEAK") {
      return run;
    }
    return this.execute(run, consumer);
  }

  public async dispatchDetached(event: Event<unknown>, consumer: Consumer<unknown>): Promise<Run<unknown>> {
    const run = await this.prepareRun(event, consumer);
    if (run.state === "WAIT_FOR_OFFPEAK") {
      return run;
    }
    const completion = this.execute(run, consumer).catch((cause: unknown) => {
      this.logger.error("run-dispatcher", "detached run execution failed", {
        runId: run.id,
        eventId: run.event.id,
        consumerId: run.consumerId,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    });
    this.detached.add(completion);
    void completion.then(() => {
      this.detached.delete(completion);
    });
    return run;
  }

  public async awaitDetached(): Promise<void> {
    // A detached run's handler may itself emit events (via the InlineProducer)
    // that dispatch further detached runs — those new promises are added to
    // `this.detached` after the current snapshot. Loop until the set drains so
    // transitively-triggered runs are awaited too, not just the initial
    // snapshot. Each iteration takes a fresh snapshot and awaits it; new
    // arrivals are picked up by the next iteration's guard check.
    while (this.detached.size > 0) {
      const snapshot = [...this.detached];
      await Promise.all(snapshot);
    }
  }

  private async prepareRun(event: Event<unknown>, consumer: Consumer<unknown>): Promise<Run<unknown>> {
    const run = new Run<unknown>(this.idGenerator.generate(), event, consumer.consumerId);
    await this.runRepository.save(run);
    this.observer.runCreated(run);

    const waitForOffPeak = await this.consumerStateRepository.getWaitForOffPeak(consumer.consumerId);
    if (waitForOffPeak) {
      const peakHours = await this.peakHoursRepository.get();
      if (this.peakSchedule.isPeakAt(peakHours, this.clock.now())) {
        run.markWaitingForOffPeak();
        await this.runRepository.save(run);
        this.observer.runStateChanged(run);
      }
    }
    return run;
  }

  public async resume(runId: string): Promise<Run<unknown> | null> {
    const run = await this.runRepository.getById(runId);
    if (run.state !== "WAIT_FOR_OFFPEAK") {
      return null;
    }
    const consumer = this.consumerRegistry
      .all()
      .find((entry) => entry.consumerId === run.consumerId);
    if (consumer === undefined) {
      run.markFailed(RunFailure.fromError(new UnexpectedHandlerError(new Error(`Consumer ${run.consumerId} no longer registered`))), this.clock.now());
      await this.runRepository.save(run);
      this.observer.runStateChanged(run);
      return run;
    }
    const enabled = await this.consumerStateRepository.get(consumer.consumerId);
    if (!enabled) {
      return run;
    }
    return this.execute(run, consumer);
  }

  private async execute(run: Run<unknown>, consumer: Consumer<unknown>): Promise<Run<unknown>> {
    const controller = new AbortController();
    let resolveCompletion: (run: Run<unknown>) => void;
    const completion = new Promise<Run<unknown>>((resolve) => {
      resolveCompletion = resolve;
    });
    const handle: AbortHandle = {
      controller,
      completion,
      resolve: (finalRun: Run<unknown>) => resolveCompletion(finalRun),
    };
    this.abortRegistry.register(run.id, handle);

    if (controller.signal.aborted) {
      run.markAborted(null, this.clock.now());
      await this.runRepository.save(run);
      this.observer.runStateChanged(run);
      this.abortRegistry.unregister(run.id);
      handle.resolve(run);
      return run;
    }

    run.markRunning(this.clock.now());
    await this.runRepository.save(run);
    this.observer.runStateChanged(run);

    if (controller.signal.aborted) {
      run.markAborted(null, this.clock.now());
      await this.runRepository.save(run);
      this.observer.runStateChanged(run);
      this.abortRegistry.unregister(run.id);
      handle.resolve(run);
      return run;
    }

    const timeoutMs = await this.timeoutResolver.resolve(consumer.consumerId);
    const timer = new PausableRunTimeout(
      controller,
      timeoutMs,
      this.inputTimeoutMs,
      () => this.clock.now().getTime(),
      this.logger,
      run.id,
      run.event.id,
      run.consumerId,
    );
    this.timeoutClock.register(run.id, timer);

    // Bind the run's identifiers to the log context for the duration of the
    // handler call so every logger sharing the scope (the handler, the task
    // runner, the opencode runner, producers emitting mid-run, ...) emits
    // eventId/runId/consumerId without each call site threading them through.
    const result = await this.logContextScope.run(
      { eventId: run.event.id, runId: run.id, consumerId: run.consumerId },
      () => this.runHandler(consumer, run, controller.signal),
    );

    timer.cancel();
    this.timeoutClock.unregister(run.id);

    if (controller.signal.aborted) {
      const timeoutFailure = resolveTimeoutFailure(controller.signal);
      if (timeoutFailure !== null) {
        run.markTimedOut(timeoutFailure, this.clock.now());
      } else {
        run.markAborted(null, this.clock.now());
      }
    } else if (result.ok) {
      run.markSucceeded(this.clock.now());
    } else if (result.error instanceof RunSupersededError) {
      // The handler signalled that the run's work is no longer relevant (the
      // PR was merged/closed, a newer run superseded this one, ...). Surface
      // it as a dedicated SUPERSEDED terminal state rather than a failure so
      // the dashboard can render it as intentionally skipped.
      this.logger.info("run-dispatcher", "run superseded before handler did its work", {
        runId: run.id,
        eventId: run.event.id,
        consumerId: run.consumerId,
        reason: result.error.reason,
      });
      run.markSuperseded(this.clock.now());
    } else {
      // Handlers wrap thrown causes inconsistently (UnexpectedHandlerError
      // preserves the cause chain; EventHandlerError flattens it into the
      // message), so a model stall is recognized by error name anywhere in the
      // chain or by its distinctive message prefix. When recognized, the
      // recorded failure carries the sentinel name so the dashboard and the
      // stall re-dispatch below can distinguish "provider stream died" from a
      // genuine handler defect.
      const stallFailure = classifyModelStall(result.error);
      run.markFailed(stallFailure ?? RunFailure.fromError(result.error), this.clock.now());
    }
    await this.runRepository.save(run);
    this.observer.runStateChanged(run);
    this.abortRegistry.unregister(run.id);

    // Run-scoped resources (the git worktree an agent run checked out) are
    // reclaimed here. Scope precision: this is the terminal transition of
    // execute() — the path every handler-executed run takes whatever ended
    // it (success, failure, timeout, abort, supersession). Two adjacent
    // terminal paths deliberately do NOT invoke the hook: a run aborted
    // before its handler could start (the pre-handler abort checks above)
    // and a resumed WAIT_FOR_OFFPEAK run whose consumer is no longer
    // registered (marked failed inside resume()). Both omissions are benign
    // by construction — no worktree can be tracked before a handler runs,
    // because tracking happens inside handler execution via the task runner.
    // Detached on purpose: cleanup can involve git commands that take
    // seconds, and handle.resolve() unblocks abort waiters that must not
    // wait on it. The hook contract forbids throwing; failures are logged,
    // never surfaced into the run's own outcome.
    void this.completionHook.runFinished({ runId: run.id, state: terminalStateOf(run), detail: finishedRunDetailOf(run) }).catch((cause: unknown) => {
      this.logger.warn("run-dispatcher", "run completion cleanup failed", {
        runId: run.id,
        eventId: run.event.id,
        consumerId: run.consumerId,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    });

    // A terminal model-stall failure is infrastructure trouble, not a verdict
    // on the work: the event chain would otherwise dead-end exactly as it did
    // for the parked off-peak run that motivated this. Give the same event a
    // fresh run (fresh prompt, fresh budget), bounded by MAX_STALL_REDISPATCH
    // stalled runs per event, counted from the repository so the cap survives
    // restarts. Disabled consumers and peak hours are honored by the normal
    // dispatch path (WAIT_FOR_OFFPEAK parking). Fire-and-forget on purpose:
    // handle.resolve() must not wait on the next run's outcome.
    if (run.state === "FAILED" && run.failure !== null && run.failure.errorName === MODEL_STALL_ERROR_NAME) {
      void this.redispatchAfterModelStall(run, consumer);
    }

    handle.resolve(run);
    return run;
  }

  private async runHandler(
    consumer: Consumer<unknown>,
    run: Run<unknown>,
    signal: AbortSignal,
  ): Promise<Result<void, EventHandlerError>> {
    try {
      return await consumer.handler.handle(run, signal);
    } catch (cause) {
      return failure<void, EventHandlerError>(new UnexpectedHandlerError(cause));
    }
  }

  // Re-dispatches the stalled run's event after honoring the consumer's
  // enabled state and the per-event stall cap. Never throws: a failure here is
  // logged and the chain dead-ends exactly as before this feature existed.
  private async redispatchAfterModelStall(run: Run<unknown>, consumer: Consumer<unknown>): Promise<void> {
    try {
      const enabled = await this.consumerStateRepository.get(consumer.consumerId);
      if (!enabled) {
        this.logger.info("run-dispatcher", "skipping model-stall re-dispatch: consumer disabled", {
          runId: run.id,
          eventId: run.event.id,
          consumerId: run.consumerId,
        });
        return;
      }
      const listed = await this.runRepository.listByEventId(run.event.id, { limit: 100, offset: 0 });
      const stalledRuns = listed.items.filter(
        (candidate) =>
          candidate.state === "FAILED" &&
          candidate.failure !== null &&
          candidate.failure.errorName === MODEL_STALL_ERROR_NAME,
      ).length;
      if (stalledRuns > MAX_STALL_REDISPATCH) {
        this.logger.warn("run-dispatcher", "model-stall re-dispatch cap reached, letting the run fail terminally", {
          runId: run.id,
          eventId: run.event.id,
          consumerId: run.consumerId,
          stalledRuns,
          maxStallRedispatch: MAX_STALL_REDISPATCH,
        });
        return;
      }
      this.logger.warn("run-dispatcher", "model-stall failure, re-dispatching event with a fresh run", {
        runId: run.id,
        eventId: run.event.id,
        consumerId: run.consumerId,
        stalledRuns,
        maxStallRedispatch: MAX_STALL_REDISPATCH,
      });
      await this.dispatchDetached(run.event, consumer);
    } catch (cause) {
      this.logger.error("run-dispatcher", "model-stall re-dispatch failed", {
        runId: run.id,
        eventId: run.event.id,
        consumerId: run.consumerId,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }
}

/**
 * Sentinel carried on `AbortController.signal.reason` when a run exceeds its
 * execution timeout (actual handler execution time, excluding time spent in
 * PENDING_INPUT). Aborting with this instance lets `execute` distinguish a
 * timeout from a manual abort so the run transitions to TIMED_OUT.
 */
class RunTimeoutAbortReason {
  public constructor(public readonly timeoutMs: number) {}
}

/**
 * Sentinel carried on `AbortController.signal.reason` when a run stays in
 * PENDING_INPUT longer than the input-wait bound — i.e. the user never
 * responded. Distinct from {@link RunTimeoutAbortReason} so the failure message
 * names the cause accurately.
 */
class RunInputTimeoutAbortReason {
  public constructor(public readonly inputTimeoutMs: number) {}
}

/**
 * The run execution timeout, pausable while the run waits for input.
 *
 * The execution budget (`execTimeoutMs`) measures ACTUAL handler execution
 * time. While a run is parked on PENDING_INPUT the run-input interactor calls
 * {@link pause}, which stops the execution clock and instead arms a longer
 * input-wait bound (`inputTimeoutMs`); {@link resume} clears that bound and
 * restarts the execution clock with whatever budget remains. Either clock
 * firing aborts the run's controller with a reason {@link execute} resolves
 * into a TIMED_OUT failure.
 *
 * A manual abort (AbortRun) aborts the controller directly; the abort listener
 * cancels both timers so a late timeout can never overwrite the abort reason.
 */
class PausableRunTimeout {
  private execHandle: ReturnType<typeof setTimeout> | null = null;
  private inputHandle: ReturnType<typeof setTimeout> | null = null;
  private elapsedExecMs = 0;
  private pausedAt: number | null = null;
  private execStartedAt: number | null = null;

  public constructor(
    private readonly controller: AbortController,
    private readonly execTimeoutMs: number,
    private readonly inputTimeoutMs: number,
    private readonly now: () => number,
    private readonly logger: Logger,
    private readonly runId: string,
    private readonly eventId: string,
    private readonly consumerId: string,
  ) {
    this.controller.signal.addEventListener("abort", () => this.cancel(), { once: true });
    this.execStartedAt = this.now();
    this.armExec(this.execTimeoutMs);
  }

  public pause(): void {
    if (this.pausedAt !== null || this.controller.signal.aborted) {
      return;
    }
    // Charge the just-ended execution segment NOW, at pause time. The parked
    // interval itself must never land in elapsedExecMs: the whole point of
    // pausing is that waiting for a human does not consume the run's work
    // budget. (Charging it at resume instead — `elapsedExecMs += now -
    // pausedAt` — retroactively billed the entire park to the execution
    // budget, so any escalation parked longer than the budget died the
    // instant the human answered, before the resumed round could run.)
    const pausedAt = this.now();
    if (this.execStartedAt !== null) {
      this.elapsedExecMs += pausedAt - this.execStartedAt;
      this.execStartedAt = null;
    }
    this.pausedAt = pausedAt;
    this.clearExec();
    this.armInput();
  }

  public resume(): void {
    if (this.pausedAt === null || this.controller.signal.aborted) {
      return;
    }
    this.pausedAt = null;
    this.clearInput();
    const remaining = this.execTimeoutMs - this.elapsedExecMs;
    if (remaining <= 0) {
      this.abort(new RunTimeoutAbortReason(this.execTimeoutMs));
      return;
    }
    this.execStartedAt = this.now();
    this.armExec(remaining);
  }

  public cancel(): void {
    this.pausedAt = null;
    this.execStartedAt = null;
    this.clearExec();
    this.clearInput();
  }

  private armExec(delayMs: number): void {
    this.clearExec();
    this.execHandle = setTimeout(() => {
      this.logger.warn("run-dispatcher", `aborting run after ${this.execTimeoutMs}ms execution timeout`, {
        runId: this.runId,
        eventId: this.eventId,
        consumerId: this.consumerId,
        execTimeoutMs: this.execTimeoutMs,
        elapsedExecMs: this.elapsedExecMs + delayMs,
      });
      this.abort(new RunTimeoutAbortReason(this.execTimeoutMs));
    }, delayMs);
  }

  private armInput(): void {
    this.clearInput();
    this.inputHandle = setTimeout(() => {
      this.logger.warn("run-dispatcher", `aborting run after ${this.inputTimeoutMs}ms input-wait timeout`, {
        runId: this.runId,
        eventId: this.eventId,
        consumerId: this.consumerId,
        inputTimeoutMs: this.inputTimeoutMs,
      });
      this.abort(new RunInputTimeoutAbortReason(this.inputTimeoutMs));
    }, this.inputTimeoutMs);
  }

  private abort(reason: RunTimeoutAbortReason | RunInputTimeoutAbortReason): void {
    this.cancel();
    if (!this.controller.signal.aborted) {
      this.controller.abort(reason);
    }
  }

  private clearExec(): void {
    if (this.execHandle !== null) {
      clearTimeout(this.execHandle);
      this.execHandle = null;
    }
  }

  private clearInput(): void {
    if (this.inputHandle !== null) {
      clearTimeout(this.inputHandle);
      this.inputHandle = null;
    }
  }
}

function resolveTimeoutFailure(signal: AbortSignal): RunFailure | null {
  if (signal.reason instanceof RunTimeoutAbortReason) {
    return new RunFailure(
      "RunTimeoutError",
      `Run timed out after exceeding its ${signal.reason.timeoutMs}ms execution timeout`,
      null,
    );
  }
  if (signal.reason instanceof RunInputTimeoutAbortReason) {
    return new RunFailure(
      "RunTimeoutError",
      `Run timed out after waiting ${signal.reason.inputTimeoutMs}ms for input`,
      null,
    );
  }
  return null;
}

// The infra layer's ModelStreamStalledError is intentionally NOT imported here
// (domain must not depend on adapters); it is identified by its error name or
// its distinctive message prefix. Keep both in sync with
// infra/adapters/opencode/session-stall-watchdog.ts.
const MODEL_STALL_ERROR_NAME = "ModelStreamStalledError";
const MODEL_STALL_MESSAGE_MARKER = "opencode model stream appeared stalled";

// How many stalled runs an event may accumulate (across re-dispatches) before
// the stall is treated as a hard outage and the failure becomes terminal.
const MAX_STALL_REDISPATCH = 2;

// Recognizes a model stall through the handler's error wrapping: either the
// sentinel error name appears somewhere in the cause chain (UnexpectedHandlerError
// preserves causes), or the sentinel message prefix survived flattening into an
// EventHandlerError's message. Returns the RunFailure to record (carrying the
// sentinel name) or null when the failure is something else entirely.
function classifyModelStall(error: unknown): RunFailure | null {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    if (current.name === MODEL_STALL_ERROR_NAME || current.message.includes(MODEL_STALL_MESSAGE_MARKER)) {
      const outer = error instanceof Error ? error : new Error(String(error));
      return new RunFailure(MODEL_STALL_ERROR_NAME, outer.message, outer.stack ?? null);
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

// The completion hook reclaims run-scoped resources and its policy depends
// on the outcome, so it must see which terminal state the run ended in. The
// execute() branch above just transitioned `run` through one of the five
// terminal mark* calls, so this never throws on that path; the switch keeps
// the narrowing explicit instead of trusting a cast.
function terminalStateOf(run: Run<unknown>): TerminalRunState {
  switch (run.state) {
    case "SUCCEEDED":
    case "FAILED":
    case "TIMED_OUT":
    case "ABORTED":
    case "SUPERSEDED":
      return run.state;
    default:
      throw new UnexpectedStateError(`run ${run.id} has no terminal state to report (state ${run.state})`);
  }
}

// Best-effort extraction of what a terminal-failure notifier needs: the
// consumer, the repo/PR the event payload carried, and the recorded failure.
// Payloads are per-consumer and untrusted shapes, so every field is probed.
function finishedRunDetailOf(run: Run<unknown>): FinishedRunDetail {
  const repo = probeRepo(run.event.payload);
  const prNumber = probePrNumber(run.event.payload);
  return {
    consumerId: run.consumerId,
    ...(repo !== null ? { repo } : {}),
    ...(prNumber !== null ? { prNumber } : {}),
    ...(run.failure !== null ? { errorName: run.failure.errorName, message: run.failure.message } : {}),
  };
}

function probeRepo(payload: unknown): FinishedRunRepoRef | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const candidate = (payload as { repo?: unknown }).repo;
  if (typeof candidate !== "object" || candidate === null) {
    return null;
  }
  const { owner, repo } = candidate as { owner?: unknown; repo?: unknown };
  if (typeof owner !== "string" || typeof repo !== "string") {
    return null;
  }
  return { owner, repo };
}

function probePrNumber(payload: unknown): number | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const number = (payload as { number?: unknown }).number;
  return typeof number === "number" ? number : null;
}
