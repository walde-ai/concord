import { Run, RunFailure, type RunState } from "../entities/run";
import type { RunRepository } from "../ports/out/run-repository";
import type { EventLifecycleObserver } from "../ports/out/event-lifecycle-observer";
import type { ConsumerRegistry } from "../ports/out/consumer-registry";
import type { ConsumerStateRepository } from "../ports/out/consumer-state-repository";
import type { RunDispatcher } from "./run-dispatcher";
import type { Clock } from "../ports/out/clock";
import type { Logger } from "../ports/out/logger";

/**
 * States whose live handler invocation is gone after a process restart. A
 * RUNNING or PENDING_INPUT run is driven by an in-memory AbortController and a
 * handler call that exist only inside the process that started them; once that
 * process exits they can never be resumed in place, so on startup we transition
 * them to FAILED and re-drive their work on a fresh run.
 *
 * WAIT_FOR_OFFPEAK is intentionally excluded: a parked run has never started a
 * handler and holds no in-memory state. It is recovered by the
 * {@link OffPeakScheduler}, which drains WAIT_FOR_OFFPEAK runs (immediately when
 * off-peak, or at the next off-peak boundary when in peak). Marking them FAILED
 * here would race that scheduler and silently drop parked work on every
 * restart.
 */
const ORPHANED_STATES: readonly RunState[] = ["RUNNING", "PENDING_INPUT"];
const RECONCILE_BATCH_LIMIT = 500;

/**
 * Runs are driven by in-memory state (an AbortController per active run and a
 * live handler invocation). When the process restarts, any run left in a
 * non-terminal, in-memory state is orphaned: its handler is gone and its abort
 * handle can never be looked up again, so it would stay RUNNING forever and
 * could never be aborted. On startup we transition such runs to FAILED so the
 * dashboard reflects reality, and we immediately re-dispatch a fresh run for
 * the same event + consumer so the work happens again instead of being
 * silently dropped. Re-dispatch is skipped (leaving the orphan FAILED) when the
 * owning consumer is no longer registered or has been disabled: in those cases
 * the operator has deliberately taken the consumer out of service and an
 * automatic restart would fight that decision.
 */
export class InterruptedRunReconciler {
  public constructor(
    private readonly runRepository: RunRepository,
    private readonly observer: EventLifecycleObserver,
    private readonly clock: Clock,
    private readonly consumerRegistry: ConsumerRegistry,
    private readonly consumerStateRepository: ConsumerStateRepository,
    private readonly runDispatcher: RunDispatcher,
    private readonly logger: Logger,
  ) {}

  // Snapshots the orphan candidates — runs whose live handler invocation
  // belonged to a previous process. App.start() captures this BEFORE anything
  // in the new process can start runs (startables, producers), then reconciles
  // exactly this snapshot once the app is fully started. Reconciling from a
  // fresh listing at that point would race runs this process legitimately
  // started (a producer's first poll can dispatch, and a fast-failing handler
  // can even finish, before the reconcile pass) and would wrongly fail
  // healthy runs as "interrupted".
  public async collectOrphans(): Promise<readonly Run<unknown>[]> {
    const collected: Run<unknown>[] = [];
    for (const state of ORPHANED_STATES) {
      const result = await this.runRepository.listByState(state, {
        limit: RECONCILE_BATCH_LIMIT,
        offset: 0,
      });
      collected.push(...result.items);
    }
    return collected;
  }

  // Terminalizes and re-dispatches orphaned runs. With no argument the
  // orphan snapshot is taken immediately (the original behaviour, used by
  // tests and safe when nothing else is dispatching); App.start() passes the
  // pre-start snapshot instead.
  public async reconcile(orphans?: readonly Run<unknown>[]): Promise<number> {
    const candidates = orphans ?? await this.collectOrphans();
    let reconciled = 0;
    for (const run of candidates) {
      this.markInterrupted(run);
      await this.runRepository.save(run);
      this.observer.runStateChanged(run);
      await this.redispatch(run);
      reconciled += 1;
    }
    return reconciled;
  }

  private markInterrupted(run: Run<unknown>): void {
    const now = this.clock.now();
    const failure = new RunFailure(
      "InterruptedError",
      "Run was interrupted by a server restart",
      null,
    );
    run.markFailed(failure, now);
  }

  private async redispatch(run: Run<unknown>): Promise<void> {
    const consumer = this.consumerRegistry
      .all()
      .find((entry) => entry.consumerId === run.consumerId);
    if (consumer === undefined) {
      this.logger.warn(
        "interrupted-run-reconciler",
        "consumer no longer registered; leaving run failed",
        { runId: run.id, eventId: run.event.id, consumerId: run.consumerId },
      );
      return;
    }
    const enabled = await this.consumerStateRepository.get(consumer.consumerId);
    if (!enabled) {
      this.logger.warn(
        "interrupted-run-reconciler",
        "consumer disabled; leaving run failed",
        { runId: run.id, eventId: run.event.id, consumerId: run.consumerId },
      );
      return;
    }
    this.logger.info(
      "interrupted-run-reconciler",
      "restarting interrupted run on a fresh run",
      { runId: run.id, eventId: run.event.id, consumerId: run.consumerId },
    );
    // dispatchDetached creates a new Run for the same event + consumer and
    // executes it without blocking startup. If the consumer is configured to
    // wait for off-peak and we are currently in peak, the new run is parked in
    // WAIT_FOR_OFFPEAK and the OffPeakScheduler picks it up later — the same
    // path a brand-new event would take. Errors here are logged but never
    // thrown: the orphan is already FAILED, and a throw would abort the
    // reconcile loop and leave later orphans stranded in a non-terminal state.
    try {
      await this.runDispatcher.dispatchDetached(run.event, consumer);
    } catch (cause) {
      this.logger.error(
        "interrupted-run-reconciler",
        "failed to re-dispatch interrupted run",
        {
          runId: run.id,
          eventId: run.event.id,
          consumerId: run.consumerId,
          error: cause instanceof Error ? cause.message : String(cause),
        },
      );
    }
  }
}
