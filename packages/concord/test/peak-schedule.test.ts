import { describe, it, expect } from "vitest";
import { IntlPeakSchedule } from "../src/infra/adapters/scheduling/intl-peak-schedule";
import type { PeakHours } from "../src/domain/peak-hours";
import { FixedClock } from "./helpers";
import { OffPeakScheduler, type SchedulerTimer } from "../src/infra/adapters/scheduling/off-peak-scheduler";
import { RunDispatcher } from "../src/domain/interactors/run-dispatcher";
import { NoOpRunCompletionHook } from "../src/domain/ports/out/run-completion-hook";
import { noopLogger } from "../src/domain/ports/out/logger";
import { noopLogContextScope } from "../src/domain/ports/out/log-context";
import { InMemoryRunRepository } from "../src/infra/adapters/stores/in-memory-run-repository";
import { InMemoryPeakHoursRepository } from "../src/infra/adapters/stores/in-memory-peak-hours-repository";
import { Event } from "../src/domain/entities/event";
import { Run, type RunState } from "../src/domain/entities/run";
import { Consumer } from "../src/domain/entities/consumer";
import { InMemoryConsumerRegistry } from "../src/infra/adapters/registry/in-memory-consumer-registry";
import { InMemoryConsumerStateRepository } from "../src/infra/adapters/stores/in-memory-consumer-state-repository";
import { InMemoryRunAbortRegistry } from "../src/infra/adapters/registry/in-memory-run-abort-registry";
import { InMemoryRunTimeoutClock } from "../src/infra/adapters/registry/in-memory-run-timeout-clock";
import { NoOpEventLifecycleObserver } from "../src/infra/adapters/api/no-op-event-lifecycle-observer";
import { SequentialIdGenerator, RecordingHandler, TypeRule, successfulOutcome, FixedRunTimeoutResolver } from "./helpers";
import { DEFAULT_RUN_TIMEOUT_MS } from "../src/domain/ports/out/run-timeout-resolver";

const ZURICH = "Europe/Zurich";

describe("IntlPeakSchedule.isPeakAt", () => {
  const schedule = new IntlPeakSchedule();

  it("returns false when peak hours are null", () => {
    expect(schedule.isPeakAt(null, new Date("2026-07-05T10:00:00Z"))).toBe(false);
  });

  it("returns false when start equals end (degenerate window)", () => {
    const peak: PeakHours = { start: "09:00", end: "09:00", timezone: ZURICH };
    expect(schedule.isPeakAt(peak, new Date("2026-07-05T08:00:00Z"))).toBe(false);
  });

  it("reports peak inside a same-day window and off-peak outside", () => {
    const peak: PeakHours = { start: "09:00", end: "17:00", timezone: ZURICH };
    // Zurich in July is UTC+2
    expect(schedule.isPeakAt(peak, new Date("2026-07-05T08:30:00Z"))).toBe(true); // 10:30 local
    expect(schedule.isPeakAt(peak, new Date("2026-07-05T06:30:00Z"))).toBe(false); // 08:30 local
    expect(schedule.isPeakAt(peak, new Date("2026-07-05T15:30:00Z"))).toBe(false); // 17:30 local
  });

  it("reports peak across midnight for an overnight window", () => {
    const peak: PeakHours = { start: "22:00", end: "06:00", timezone: ZURICH };
    expect(schedule.isPeakAt(peak, new Date("2026-07-05T21:00:00Z"))).toBe(true); // 23:00 local
    expect(schedule.isPeakAt(peak, new Date("2026-07-05T03:00:00Z"))).toBe(true); // 05:00 local
    expect(schedule.isPeakAt(peak, new Date("2026-07-05T07:00:00Z"))).toBe(false); // 09:00 local
    expect(schedule.isPeakAt(peak, new Date("2026-07-05T17:00:00Z"))).toBe(false); // 19:00 local
  });
});

describe("IntlPeakSchedule.nextOffPeakBoundary", () => {
  const schedule = new IntlPeakSchedule();

  it("returns null when peak hours are null", () => {
    expect(schedule.nextOffPeakBoundary(null, new Date())).toBeNull();
  });

  it("returns null when start equals end", () => {
    const peak: PeakHours = { start: "09:00", end: "09:00", timezone: ZURICH };
    expect(schedule.nextOffPeakBoundary(peak, new Date())).toBeNull();
  });

  it("returns today's end boundary when still in the future", () => {
    const peak: PeakHours = { start: "09:00", end: "17:00", timezone: ZURICH };
    const boundary = schedule.nextOffPeakBoundary(peak, new Date("2026-07-05T08:30:00Z"));
    expect(boundary?.toISOString()).toBe("2026-07-05T15:00:00.000Z");
  });

  it("returns tomorrow's end boundary when today's has passed", () => {
    const peak: PeakHours = { start: "09:00", end: "17:00", timezone: ZURICH };
    const boundary = schedule.nextOffPeakBoundary(peak, new Date("2026-07-05T16:00:00Z"));
    expect(boundary?.toISOString()).toBe("2026-07-06T15:00:00.000Z");
  });
});

describe("IntlPeakSchedule daylight-saving handling", () => {
  it("computes the boundary correctly around the spring-forward transition", () => {
    const schedule = new IntlPeakSchedule();
    const peak: PeakHours = { start: "09:00", end: "17:00", timezone: ZURICH };
    // Before the switch, Zurich is UTC+1; the end boundary 17:00 local = 16:00 UTC.
    const boundaryBefore = schedule.nextOffPeakBoundary(peak, new Date("2026-03-28T10:00:00Z"));
    expect(boundaryBefore?.toISOString()).toBe("2026-03-28T16:00:00.000Z");
    // After the switch, Zurich is UTC+2; the end boundary 17:00 local = 15:00 UTC.
    const boundaryAfter = schedule.nextOffPeakBoundary(peak, new Date("2026-03-30T10:00:00Z"));
    expect(boundaryAfter?.toISOString()).toBe("2026-03-30T15:00:00.000Z");
  });
});

class FakeTimerController implements SchedulerTimer {
  public readonly armCalls: Array<{ readonly ms: number }> = [];
  public clearCalls: unknown[] = [];
  private counter = 0;
  public setTimeout(_callback: () => void, ms: number): unknown {
    this.counter += 1;
    this.armCalls.push({ ms });
    return this.counter;
  }
  public clearTimeout(handle: unknown): void {
    this.clearCalls.push(handle);
  }
}

function buildDispatcher(opts: {
  readonly peakHours: PeakHours | null;
  readonly now: Date;
  readonly peak: boolean;
}): { readonly dispatcher: RunDispatcher; readonly runRepository: InMemoryRunRepository } {
  const runRepository = new InMemoryRunRepository();
  const peakHoursRepository = new InMemoryPeakHoursRepository();
  void peakHoursRepository.set(opts.peakHours);
  const consumerStateRepository = new InMemoryConsumerStateRepository();
  const consumerRegistry = new InMemoryConsumerRegistry();
  consumerRegistry.register(new Consumer<unknown>("c-1", new TypeRule("foo"), new RecordingHandler(successfulOutcome()), [], []));
  const dispatcher = new RunDispatcher(
    runRepository,
    new SequentialIdGenerator(),
    new NoOpEventLifecycleObserver(),
    new InMemoryRunAbortRegistry(),
    new FixedClock(opts.now),
    peakHoursRepository,
    { isPeakAt: () => opts.peak, nextOffPeakBoundary: () => null },
    consumerStateRepository,
    consumerRegistry,
    new FixedRunTimeoutResolver(DEFAULT_RUN_TIMEOUT_MS),
    new InMemoryRunTimeoutClock(),
    noopLogger,
    noopLogContextScope,
    new NoOpRunCompletionHook(),
  );
  return { dispatcher, runRepository };
}

describe("OffPeakScheduler", () => {
  it("drains parked runs immediately on startup when peak hours are null", async () => {
    const now = new Date("2026-07-05T12:00:00Z");
    const { dispatcher, runRepository } = buildDispatcher({ peakHours: null, now, peak: false });
    const event = new Event<unknown>("evt-1", "p-1", "pevt-1", now, "foo", {});
    await runRepository.save(new Run<unknown>("parked-1", event, "c-1", "WAIT_FOR_OFFPEAK", null));
    const peakHoursRepository = new InMemoryPeakHoursRepository();
    const timer = new FakeTimerController();
    const scheduler = new OffPeakScheduler(dispatcher, runRepository, peakHoursRepository, new IntlPeakSchedule(), new FixedClock(now), timer);

    await scheduler.start();
    const parked = await runRepository.listByState("WAIT_FOR_OFFPEAK", { limit: 10, offset: 0 });
    expect(parked.items).toHaveLength(0);
    await scheduler.close();
  });

  it("arms a timer on startup when currently in peak", async () => {
    const now = new Date("2026-07-05T12:00:00Z");
    const { dispatcher, runRepository } = buildDispatcher({
      peakHours: { start: "00:00", end: "23:59", timezone: "UTC" },
      now,
      peak: true,
    });
    const peakHoursRepository = new InMemoryPeakHoursRepository();
    await peakHoursRepository.set({ start: "00:00", end: "23:59", timezone: "UTC" });
    const timer = new FakeTimerController();
    const scheduler = new OffPeakScheduler(dispatcher, runRepository, peakHoursRepository, new IntlPeakSchedule(), new FixedClock(now), timer);

    await scheduler.start();
    expect(timer.armCalls.length).toBe(1);
    await scheduler.close();
  });

  it("drains parked runs on peakHoursChanged to null and cancels the timer", async () => {
    const now = new Date("2026-07-05T12:00:00Z");
    const { dispatcher, runRepository } = buildDispatcher({
      peakHours: { start: "00:00", end: "23:59", timezone: "UTC" },
      now,
      peak: true,
    });
    const event = new Event<unknown>("evt-1", "p-1", "pevt-1", now, "foo", {});
    await runRepository.save(new Run<unknown>("parked-1", event, "c-1", "WAIT_FOR_OFFPEAK", null));
    const peakHoursRepository = new InMemoryPeakHoursRepository();
    await peakHoursRepository.set({ start: "00:00", end: "23:59", timezone: "UTC" });
    const timer = new FakeTimerController();
    const scheduler = new OffPeakScheduler(dispatcher, runRepository, peakHoursRepository, new IntlPeakSchedule(), new FixedClock(now), timer);

    await scheduler.start();
    timer.clearCalls.length = 0;
    await scheduler.peakHoursChanged(null);
    const parked = await runRepository.listByState("WAIT_FOR_OFFPEAK", { limit: 10, offset: 0 });
    expect(parked.items).toHaveLength(0);
    expect(timer.clearCalls.length).toBe(1);
    await scheduler.close();
  });

  it("re-arms but does not drain when peakHoursChanged while still in peak", async () => {
    const now = new Date("2026-07-05T12:00:00Z");
    const { dispatcher, runRepository } = buildDispatcher({
      peakHours: { start: "00:00", end: "23:59", timezone: "UTC" },
      now,
      peak: true,
    });
    const peakHoursRepository = new InMemoryPeakHoursRepository();
    await peakHoursRepository.set({ start: "00:00", end: "23:59", timezone: "UTC" });
    const timer = new FakeTimerController();
    const scheduler = new OffPeakScheduler(dispatcher, runRepository, peakHoursRepository, new IntlPeakSchedule(), new FixedClock(now), timer);

    await scheduler.start();
    const armedBefore = timer.armCalls.length;
    await scheduler.peakHoursChanged({ start: "00:00", end: "20:00", timezone: "UTC" });
    expect(timer.armCalls.length).toBe(armedBefore + 1);
    await scheduler.close();
  });
});

describe("RunRepository.listByState", () => {
  it("lists only runs matching the given state", async () => {
    const repo = new InMemoryRunRepository();
    const event = new Event<unknown>("evt-1", "p-1", "pevt-1", new Date(), "foo", {});
    await repo.save(new Run<unknown>("r-1", event, "c-1", "WAIT_FOR_OFFPEAK", null));
    await repo.save(new Run<unknown>("r-2", event, "c-1", "SUCCEEDED", null));
    await repo.save(new Run<unknown>("r-3", event, "c-1", "WAIT_FOR_OFFPEAK", null));

    const result = await repo.listByState("WAIT_FOR_OFFPEAK" as RunState, { limit: 10, offset: 0 });
    expect(result.total).toBe(2);
    expect(result.items.map((r) => r.id).sort()).toEqual(["r-1", "r-3"]);
  });
});
