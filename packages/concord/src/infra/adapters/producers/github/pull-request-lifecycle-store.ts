export interface PrLifecycleState {
  headSha: string;
  openedEmitted: boolean;
  mergeConflictsEmittedForSha: boolean;
  testsTerminalEmittedForSha: boolean;
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
