import { Event } from "./event";
import { IllegalRunTransitionError } from "../exceptions/errors";

export type RunState =
  | "NOT_STARTED"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "ABORTED"
  | "TIMED_OUT"
  | "WAIT_FOR_OFFPEAK"
  | "PENDING_INPUT"
  | "SUPERSEDED";

export class RunFailure {
  public constructor(
    public readonly errorName: string,
    public readonly message: string,
    public readonly stack: string | null,
  ) {}

  public static fromError(error: Error): RunFailure {
    return new RunFailure(error.name, error.message, error.stack ?? null);
  }
}

export class Run<T> {
  public state: RunState;
  public failure: RunFailure | null;
  public startedAt: Date | null;
  public finishedAt: Date | null;

  public constructor(
    public readonly id: string,
    public readonly event: Event<T>,
    public readonly consumerId: string,
    state: RunState = "NOT_STARTED",
    failure: RunFailure | null = null,
    startedAt: Date | null = null,
    finishedAt: Date | null = null,
  ) {
    this.state = state;
    this.failure = failure;
    this.startedAt = startedAt;
    this.finishedAt = finishedAt;
  }

  public markRunning(now: Date = new Date()): void {
    if (this.state !== "NOT_STARTED" && this.state !== "WAIT_FOR_OFFPEAK" && this.state !== "PENDING_INPUT") {
      throw new IllegalRunTransitionError(this.state, "RUNNING");
    }
    this.state = "RUNNING";
    if (this.startedAt === null) {
      this.startedAt = now;
    }
  }

  public markSucceeded(now: Date = new Date()): void {
    if (this.state !== "RUNNING") {
      throw new IllegalRunTransitionError(this.state, "SUCCEEDED");
    }
    this.state = "SUCCEEDED";
    this.failure = null;
    this.finishedAt = now;
  }

  public markFailed(failure: RunFailure, now: Date = new Date()): void {
    if (this.state !== "RUNNING" && this.state !== "WAIT_FOR_OFFPEAK" && this.state !== "PENDING_INPUT") {
      throw new IllegalRunTransitionError(this.state, "FAILED");
    }
    this.state = "FAILED";
    this.failure = failure;
    this.finishedAt = now;
  }

  public markAborted(failure: RunFailure | null, now: Date = new Date()): void {
    if (
      this.state !== "NOT_STARTED" &&
      this.state !== "RUNNING" &&
      this.state !== "WAIT_FOR_OFFPEAK" &&
      this.state !== "PENDING_INPUT"
    ) {
      throw new IllegalRunTransitionError(this.state, "ABORTED");
    }
    this.state = "ABORTED";
    this.failure = failure;
    this.finishedAt = now;
  }

  public markTimedOut(failure: RunFailure, now: Date = new Date()): void {
    if (this.state !== "RUNNING" && this.state !== "PENDING_INPUT") {
      throw new IllegalRunTransitionError(this.state, "TIMED_OUT");
    }
    this.state = "TIMED_OUT";
    this.failure = failure;
    this.finishedAt = now;
  }

  public markWaitingForOffPeak(): void {
    if (this.state !== "NOT_STARTED") {
      throw new IllegalRunTransitionError(this.state, "WAIT_FOR_OFFPEAK");
    }
    this.state = "WAIT_FOR_OFFPEAK";
  }

  public markPendingInput(now: Date = new Date()): void {
    if (this.state !== "RUNNING") {
      throw new IllegalRunTransitionError(this.state, "PENDING_INPUT");
    }
    this.state = "PENDING_INPUT";
  }

  public markSuperseded(now: Date = new Date()): void {
    if (this.state !== "RUNNING") {
      throw new IllegalRunTransitionError(this.state, "SUPERSEDED");
    }
    this.state = "SUPERSEDED";
    this.failure = null;
    this.finishedAt = now;
  }
}
