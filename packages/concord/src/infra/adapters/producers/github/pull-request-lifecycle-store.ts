// Which terminal tests verdict has been emitted for the current head SHA.
// - null: no terminal verdict emitted yet; the producer evaluates the checks
//   on every scan and emits the first terminal outcome it observes.
// - "failed": a pr.tests_failed was emitted for this SHA, but the outcome is
//   NOT final for the SHA: a code-fixing consumer's justified no-fix path
//   re-runs
//   failed jobs (gh run rerun) without pushing, which can flip the same SHA
//   from failed to succeeded. The producer keeps watching and emits
//   pr.tests_succeeded when the re-run goes green.
// - "succeeded": a pr.tests_succeeded was emitted for this SHA; the SHA is
//   fully terminal and is not re-evaluated.
export type EmittedTestsOutcome = "failed" | "succeeded";

export interface PrLifecycleState {
  headSha: string;
  openedEmitted: boolean;
  mergeConflictsEmittedForSha: boolean;
  testsOutcomeEmittedForSha: EmittedTestsOutcome | null;
  // Number of consecutive scans that observed neither check runs nor check
  // suites for the current head SHA. Used to wait out the brief window between
  // a push and GitHub Actions registering the first check suite, so that an
  // empty first poll is not misread as "this repository has no tests
  // configured". Reset to zero whenever the SHA changes, whenever any check
  // run is observed, or whenever any check suite is observed.
  consecutiveEmptyScansForSha: number;
  mergedEmitted: boolean;
  terminal: boolean;
}

export interface StoredLifecycleEntry {
  readonly key: string;
  readonly state: PrLifecycleState;
}

export interface PullRequestLifecycleStore {
  get(key: string): Promise<PrLifecycleState | null>;
  save(key: string, state: PrLifecycleState): Promise<void>;
  list(): Promise<readonly StoredLifecycleEntry[]>;
}
