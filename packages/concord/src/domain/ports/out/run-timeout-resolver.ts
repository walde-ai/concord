/**
 * Resolves the maximum execution time (in milliseconds) after which a run for
 * the given consumer is automatically aborted. The timeout bounds the total
 * wall-clock duration of a single run execution, including any time spent
 * waiting for run input. A consumer that never finishes (a hung agent process,
 * an unresponsive network request, an infinite tool loop) is aborted so it
 * cannot occupy the RUNNING state forever.
 */
export interface RunTimeoutResolver {
  resolve(consumerId: string): Promise<number>;
}

/**
 * Default run timeout applied when a consumer does not declare an explicit
 * `runTimeoutMs` config value. One hour matches the long-running nature of the
 * agent consumers (opencode sessions that drive code-producing tasks).
 */
export const DEFAULT_RUN_TIMEOUT_MS: number = 60 * 60 * 1000;

/**
 * Default upper bound on how long a single run may remain in the PENDING_INPUT
 * state waiting for a human to submit a form. The execution timeout
 * ({@link DEFAULT_RUN_TIMEOUT_MS}) is paused while a run waits for input, so a
 * separate, longer wall-clock bound is needed to guarantee an abandoned run
 * eventually leaves PENDING_INPUT. A full day accommodates a user across time
 * zones without leaving runs parked indefinitely.
 */
export const DEFAULT_RUN_INPUT_TIMEOUT_MS: number = 24 * 60 * 60 * 1000;
