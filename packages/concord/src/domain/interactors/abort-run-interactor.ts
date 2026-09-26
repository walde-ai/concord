import type { Run } from "../entities/run";
import type { AbortRun } from "../ports/in/abort-run";
import type { RunRepository } from "../ports/out/run-repository";
import type { EventLifecycleObserver } from "../ports/out/event-lifecycle-observer";
import type { RunAbortRegistry } from "../ports/out/run-abort-registry";
import { RunNotAbortableError } from "../exceptions/errors";

const TERMINAL_STATES: ReadonlySet<string> = new Set(["SUCCEEDED", "FAILED", "ABORTED", "TIMED_OUT", "SUPERSEDED"]);

export class AbortRunInteractor implements AbortRun {
  public constructor(
    private readonly runRepository: RunRepository,
    private readonly abortRegistry: RunAbortRegistry,
    private readonly observer: EventLifecycleObserver,
  ) {}

  public async abort(runId: string): Promise<Run<unknown>> {
    const run = await this.runRepository.getById(runId);
    if (TERMINAL_STATES.has(run.state)) {
      throw new RunNotAbortableError(runId, run.state);
    }
    if (run.state === "WAIT_FOR_OFFPEAK") {
      run.markAborted(null);
      await this.runRepository.save(run);
      this.observer.runStateChanged(run);
      return run;
    }
    const handle = this.abortRegistry.lookup(runId);
    if (handle === null) {
      throw new RunNotAbortableError(runId, run.state);
    }
    handle.controller.abort();
    return handle.completion;
  }
}
