import { describe, it, expect } from "vitest";
import { Run, RunFailure, type RunState } from "../src/domain/entities/run";
import { Event } from "../src/domain/entities/event";
import { IllegalRunTransitionError } from "../src/domain/exceptions/errors";
import { RunV1 } from "../src/infra/adapters/stores/sqlite/dto/run-v1";

const NOW = new Date("2026-07-05T12:00:00Z");

function newRun(state: RunState = "NOT_STARTED", failure: RunFailure | null = null): Run<unknown> {
  const event = new Event<unknown>("evt-1", "p-1", "pevt-1", NOW, "foo", {});
  return new Run<unknown>("run-1", event, "c-1", state, failure);
}

describe("Run state machine: WAIT_FOR_OFFPEAK", () => {
  it("markWaitingForOffPeak transitions from NOT_STARTED", () => {
    const run = newRun();
    run.markWaitingForOffPeak();
    expect(run.state).toBe("WAIT_FOR_OFFPEAK");
  });

  it("markWaitingForOffPeak throws IllegalRunTransitionError from RUNNING", () => {
    const run = newRun("RUNNING");
    expect(() => run.markWaitingForOffPeak()).toThrow(IllegalRunTransitionError);
  });

  it("markWaitingForOffPeak throws from terminal states", () => {
    for (const state of ["SUCCEEDED", "FAILED", "ABORTED", "TIMED_OUT", "WAIT_FOR_OFFPEAK", "SUPERSEDED"] as RunState[]) {
      const run = newRun(state);
      expect(() => run.markWaitingForOffPeak()).toThrow(IllegalRunTransitionError);
    }
  });

  it("markAborted accepts WAIT_FOR_OFFPEAK as a legal source", () => {
    const run = newRun("WAIT_FOR_OFFPEAK");
    run.markAborted(null);
    expect(run.state).toBe("ABORTED");
  });

  it("markAborted still accepts NOT_STARTED and RUNNING", () => {
    const a = newRun("NOT_STARTED");
    a.markAborted(null);
    expect(a.state).toBe("ABORTED");
    const b = newRun("RUNNING");
    b.markAborted(null);
    expect(b.state).toBe("ABORTED");
  });

  it("markAborted throws from terminal states", () => {
    for (const state of ["SUCCEEDED", "FAILED", "ABORTED", "TIMED_OUT", "SUPERSEDED"] as RunState[]) {
      const run = newRun(state);
      expect(() => run.markAborted(null)).toThrow(IllegalRunTransitionError);
    }
  });

  it("markAborted records a failure reason when one is supplied", () => {
    const run = newRun("RUNNING");
    const failure = RunFailure.fromError(new Error("timed out"));
    run.markAborted(failure);
    expect(run.state).toBe("ABORTED");
    expect(run.failure).toBe(failure);
  });

  it("markAborted clears any prior failure when aborted without a reason", () => {
    const run = newRun("RUNNING", RunFailure.fromError(new Error("stale")));
    run.markAborted(null);
    expect(run.state).toBe("ABORTED");
    expect(run.failure).toBeNull();
  });
});

describe("Run state machine: TIMED_OUT", () => {
  it("markTimedOut transitions from RUNNING", () => {
    const run = newRun("RUNNING");
    const failure = RunFailure.fromError(new Error("timed out"));
    run.markTimedOut(failure);
    expect(run.state).toBe("TIMED_OUT");
    expect(run.failure).toBe(failure);
  });

  it("markTimedOut throws from NOT_STARTED", () => {
    const run = newRun("NOT_STARTED");
    const failure = RunFailure.fromError(new Error("timed out"));
    expect(() => run.markTimedOut(failure)).toThrow(IllegalRunTransitionError);
  });

  it("markTimedOut throws from terminal states", () => {
    for (const state of ["SUCCEEDED", "FAILED", "ABORTED", "TIMED_OUT", "SUPERSEDED"] as RunState[]) {
      const run = newRun(state);
      const failure = RunFailure.fromError(new Error("timed out"));
      expect(() => run.markTimedOut(failure)).toThrow(IllegalRunTransitionError);
    }
  });

  it("markTimedOut records the finish time", () => {
    const finished = new Date("2026-07-05T12:05:00Z");
    const run = newRun("RUNNING");
    run.markTimedOut(RunFailure.fromError(new Error("timed out")), finished);
    expect(run.state).toBe("TIMED_OUT");
    expect(run.finishedAt).toEqual(finished);
  });
});

describe("Run timestamps", () => {
  it("markRunning from WAIT_FOR_OFFPEAK records the start time", () => {
    const run = newRun();
    run.markWaitingForOffPeak();
    const start = new Date("2026-07-05T12:00:00Z");
    run.markRunning(start);
    expect(run.state).toBe("RUNNING");
    expect(run.startedAt).toEqual(start);
    expect(run.finishedAt).toBeNull();
  });

  it("markRunning on a fresh run records the start time", () => {
    const run = newRun();
    const start = new Date("2026-07-05T12:00:00Z");
    run.markRunning(start);
    expect(run.startedAt).toEqual(start);
    expect(run.finishedAt).toBeNull();
  });

  it("terminal transitions record the finish time", () => {
    const finished = new Date("2026-07-05T12:05:00Z");
    const succeeded = newRun("RUNNING");
    succeeded.markSucceeded(finished);
    expect(succeeded.state).toBe("SUCCEEDED");
    expect(succeeded.finishedAt).toEqual(finished);

    const failed = newRun("RUNNING");
    failed.markFailed(RunFailure.fromError(new Error("boom")), finished);
    expect(failed.state).toBe("FAILED");
    expect(failed.finishedAt).toEqual(finished);

    const aborted = newRun("RUNNING");
    aborted.markAborted(null, finished);
    expect(aborted.state).toBe("ABORTED");
    expect(aborted.finishedAt).toEqual(finished);

    const timedOut = newRun("RUNNING");
    timedOut.markTimedOut(RunFailure.fromError(new Error("timeout")), finished);
    expect(timedOut.state).toBe("TIMED_OUT");
    expect(timedOut.finishedAt).toEqual(finished);
  });

  it("leaves startedAt/finishedAt null for a fresh run", () => {
    const run = newRun();
    expect(run.startedAt).toBeNull();
    expect(run.finishedAt).toBeNull();
  });
});

describe("RunV1 timestamp round-trip", () => {
  it("preserves startedAt and finishedAt through serialisation", () => {
    const event = new Event<unknown>("evt-1", "p-1", "pevt-1", NOW, "foo", {});
    const start = new Date("2026-07-05T12:00:00Z");
    const end = new Date("2026-07-05T12:02:30Z");
    const run = new Run<unknown>("run-1", event, "c-1", "RUNNING", null, start, end);
    const restored = RunV1.fromDomain(run).toDomain(event);
    expect(restored.startedAt).toEqual(start);
    expect(restored.finishedAt).toEqual(end);
  });

  it("round-trips null timestamps for a NOT_STARTED run", () => {
    const event = new Event<unknown>("evt-1", "p-1", "pevt-1", NOW, "foo", {});
    const run = new Run<unknown>("run-1", event, "c-1", "NOT_STARTED", null);
    const restored = RunV1.fromDomain(run).toDomain(event);
    expect(restored.startedAt).toBeNull();
    expect(restored.finishedAt).toBeNull();
  });
});

describe("RunV1 round-trip for WAIT_FOR_OFFPEAK", () => {
  it("serialises and restores a WAIT_FOR_OFFPEAK run through the DTO", () => {
    const event = new Event<unknown>("evt-1", "p-1", "pevt-1", NOW, "foo", {});
    const run = new Run<unknown>("run-1", event, "c-1", "WAIT_FOR_OFFPEAK", null);
    const dto = RunV1.fromDomain(run);
    expect(dto.state).toBe("WAIT_FOR_OFFPEAK");
    const restored = dto.toDomain(event);
    expect(restored.state).toBe("WAIT_FOR_OFFPEAK");
    expect(restored.consumerId).toBe("c-1");
  });

  it("RunFailure round-trips alongside a parked run", () => {
    const event = new Event<unknown>("evt-1", "p-1", "pevt-1", NOW, "foo", {});
    const failure = RunFailure.fromError(new Error("boom"));
    const run = new Run<unknown>("run-1", event, "c-1", "WAIT_FOR_OFFPEAK", failure);
    const dto = RunV1.fromDomain(run);
    expect(dto.failure).toBe(failure);
    const restored = dto.toDomain(event);
    expect(restored.failure?.message).toBe("boom");
  });
});

describe("Run state machine: PENDING_INPUT", () => {
  it("markPendingInput transitions from RUNNING", () => {
    const run = newRun("RUNNING");
    run.markPendingInput();
    expect(run.state).toBe("PENDING_INPUT");
  });

  it("markPendingInput throws IllegalRunTransitionError from any non-RUNNING state", () => {
    for (const state of ["NOT_STARTED", "SUCCEEDED", "FAILED", "ABORTED", "TIMED_OUT", "WAIT_FOR_OFFPEAK", "SUPERSEDED"] as RunState[]) {
      const run = newRun(state);
      expect(() => run.markPendingInput()).toThrow(IllegalRunTransitionError);
    }
  });

  it("markRunning accepts PENDING_INPUT and returns to RUNNING without resetting startedAt", () => {
    const start = new Date("2026-07-05T12:00:00Z");
    const run = newRun();
    run.markRunning(start);
    run.markPendingInput();
    const resumedAt = new Date("2026-07-05T12:05:00Z");
    run.markRunning(resumedAt);
    expect(run.state).toBe("RUNNING");
    expect(run.startedAt).toEqual(start);
  });

  it("markAborted accepts PENDING_INPUT", () => {
    const start = new Date("2026-07-05T12:00:00Z");
    const run = newRun();
    run.markRunning(start);
    run.markPendingInput();
    run.markAborted(null);
    expect(run.state).toBe("ABORTED");
  });

  it("markSucceeded throws from PENDING_INPUT", () => {
    const start = new Date("2026-07-05T12:00:00Z");
    const run = newRun();
    run.markRunning(start);
    run.markPendingInput();
    expect(() => run.markSucceeded()).toThrow(IllegalRunTransitionError);
  });

  it("RunV1 round-trips a PENDING_INPUT run", () => {
    const event = new Event<unknown>("evt-1", "p-1", "pevt-1", NOW, "foo", {});
    const start = new Date("2026-07-05T12:00:00Z");
    const run = new Run<unknown>("run-1", event, "c-1", "RUNNING", null, start);
    run.markPendingInput();
    const restored = RunV1.fromDomain(run).toDomain(event);
    expect(restored.state).toBe("PENDING_INPUT");
    expect(restored.startedAt).toEqual(start);
  });
});

describe("Run state machine: SUPERSEDED", () => {
  it("markSuperseded transitions from RUNNING and clears any prior failure", () => {
    const run = newRun("RUNNING", RunFailure.fromError(new Error("stale")));
    const finished = new Date("2026-07-05T12:05:00Z");
    run.markSuperseded(finished);
    expect(run.state).toBe("SUPERSEDED");
    expect(run.failure).toBeNull();
    expect(run.finishedAt).toEqual(finished);
  });

  it("markSuperseded throws IllegalRunTransitionError from any non-RUNNING state", () => {
    for (const state of ["NOT_STARTED", "SUCCEEDED", "FAILED", "ABORTED", "TIMED_OUT", "WAIT_FOR_OFFPEAK", "PENDING_INPUT", "SUPERSEDED"] as RunState[]) {
      const run = newRun(state);
      expect(() => run.markSuperseded()).toThrow(IllegalRunTransitionError);
    }
  });

  it("RunV1 round-trips a SUPERSEDED run through the DTO", () => {
    const event = new Event<unknown>("evt-1", "p-1", "pevt-1", NOW, "foo", {});
    const start = new Date("2026-07-05T12:00:00Z");
    const finished = new Date("2026-07-05T12:05:00Z");
    const run = new Run<unknown>("run-1", event, "c-1", "RUNNING", null, start);
    run.markSuperseded(finished);
    const restored = RunV1.fromDomain(run).toDomain(event);
    expect(restored.state).toBe("SUPERSEDED");
    expect(restored.failure).toBeNull();
    expect(restored.finishedAt).toEqual(finished);
  });
});
