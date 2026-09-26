/**
 * A pausable, cancellable execution-timeout handle owned by the dispatcher for
 * a single in-flight run. The dispatcher {@link RunTimeoutClock.register}s one
 * per run; the run-input interactor {@link RunTimeoutClock.pause}s it when the
 * run parks on PENDING_INPUT and {@link RunTimeoutClock.resume}s it when the
 * run resumes, so the execution budget excludes time spent waiting for a human.
 */
export interface RunTimeoutHandle {
  pause(): void;
  resume(): void;
  cancel(): void;
}

/**
 * Coordinates the pausable execution timeout between the run dispatcher (which
 * arms and cancels it) and the run-input interactor (which pauses it while a
 * run waits for a form and resumes it once the form is submitted). The
 * execution timeout measures actual handler execution time, NOT wall-clock
 * time, so a user taking hours to answer does not consume the run's budget.
 */
export interface RunTimeoutClock {
  register(runId: string, handle: RunTimeoutHandle): void;
  unregister(runId: string): void;
  pause(runId: string): void;
  resume(runId: string): void;
}
