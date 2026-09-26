import { describe, it, expect, vi } from "vitest";

import {
  SessionStallWatchdog,
  ToolStreamStalledError,
  ModelStreamStalledError,
  TimeoutStallScheduler,
  DEFAULT_TOOL_STALL_MULTIPLIER,
  type StallHandle,
  type StallScheduler,
} from "../src/infra/adapters/opencode/session-stall-watchdog";
import type { Logger } from "../src/domain/ports/out/logger";
import type { OpencodeEvent } from "../src/infra/adapters/opencode/opencode-sdk-runner";

// A controllable scheduler + clock so the watchdog's time-based behaviour is
// tested deterministically without real timers.
class FakeScheduler implements StallScheduler {
  public pending: (() => void) | null = null;
  public schedule(_ms: number, fn: () => void): StallHandle {
    this.pending = fn;
    return {
      clear: () => {
        if (this.pending === fn) {
          this.pending = null;
        }
      },
    };
  }
  public fire(): void {
    const fn = this.pending;
    this.pending = null;
    if (fn !== null) {
      fn();
    }
  }
}

interface FakeClock {
  now: number;
}

interface WarnEntry {
  readonly source: string;
  readonly message: string;
  readonly fields: Record<string, unknown>;
}

class RecordingLogger implements Logger {
  public readonly warnings: WarnEntry[] = [];

  public log(): void {}
  public debug(): void {}
  public info(): void {}
  public warn(source: string, message: string, fields: Record<string, unknown> = {}): void {
    this.warnings.push({ source, message, fields });
  }
  public error(): void {}
}

function makeWatchdog(
  thresholdMs: number,
  clock: FakeClock,
  scheduler: FakeScheduler,
  logger: Logger = new RecordingLogger(),
  toolStallTimeoutMs?: number,
  maxCumulativeModelIdleMs?: number,
): { watchdog: SessionStallWatchdog; logger: RecordingLogger } {
  const rec = logger instanceof RecordingLogger ? logger : new RecordingLogger();
  const watchdog = new SessionStallWatchdog(thresholdMs, rec, {
    clock: () => clock.now,
    scheduler,
  }, toolStallTimeoutMs, maxCumulativeModelIdleMs);
  return { watchdog, logger: rec };
}

function event(type: string): OpencodeEvent {
  return { type, properties: {} };
}

function makeTarget(): { abort: ReturnType<typeof vi.fn>; reason: unknown } {
  const state: { reason: unknown } = { reason: undefined };
  return {
    abort: vi.fn((reason?: unknown) => {
      state.reason = reason;
    }),
    get reason(): unknown {
      return state.reason;
    },
  };
}

const TOOL_CALLED = "session.next.tool.called";
const TOOL_SUCCESS = "session.next.tool.success";
const TEXT_DELTA = "session.next.text.delta";

describe("SessionStallWatchdog", () => {
  it("does NOT abort when the model is idle past the threshold; emits a heartbeat and keeps waiting", () => {
    const clock: FakeClock = { now: 0 };
    const scheduler = new FakeScheduler();
    const { watchdog, logger } = makeWatchdog(60_000, clock, scheduler);

    watchdog.arm();
    const target = makeTarget();
    watchdog.beginAttempt(target);

    // no events at all — model never started streaming. Past the threshold the
    // watchdog must NOT abort: opencode itself retries when the model is
    // unavailable (the CLI relies on the same mechanism). It only logs.
    clock.now = 60_001;
    scheduler.fire();

    expect(target.abort).not.toHaveBeenCalled();
    expect(logger.warnings).toHaveLength(1);
    expect(logger.warnings[0]!.message).toMatch(/model idle past threshold/);
    expect(logger.warnings[0]!.fields).toMatchObject({ idleMs: 60_001, modelIdleThresholdMs: 60_000 });

    // Subsequent threshold crossings keep heartbeating and STILL do not abort —
    // the run's own AbortSignal bounds a permanently dead model, not the watchdog.
    clock.now = 120_001;
    scheduler.fire();
    expect(target.abort).not.toHaveBeenCalled();
    expect(logger.warnings).toHaveLength(2);
  });

  it("does NOT abort while a tool is running and still producing activity within the tool-stall window", () => {
    const clock: FakeClock = { now: 0 };
    const scheduler = new FakeScheduler();
    // model idle threshold 60s, tool stall 180s (3x default)
    const { watchdog } = makeWatchdog(60_000, clock, scheduler);

    watchdog.arm();
    const target = makeTarget();
    watchdog.beginAttempt(target);
    // the model called bash; bash runs a multi-minute test suite
    watchdog.observe(event(TOOL_CALLED));

    // the tool keeps emitting activity (e.g. streamed output parts) every 60s,
    // well inside the 180s tool-stall window, for a long time
    for (let t = 60_000; t < 600_000; t += 60_000) {
      clock.now = t;
      watchdog.observe(event("message.part.updated"));
      scheduler.fire();
    }
    expect(target.abort).not.toHaveBeenCalled();
  });

  it("aborts with ToolStreamStalledError when a tool stays in-flight with no activity past the tool-stall window", () => {
    const clock: FakeClock = { now: 0 };
    const scheduler = new FakeScheduler();
    const { watchdog } = makeWatchdog(60_000, clock, scheduler, undefined, 180_000);

    watchdog.arm();
    const target = makeTarget();
    watchdog.beginAttempt(target);
    watchdog.observe(event(TOOL_CALLED));

    // within the tool-stall window: defer
    clock.now = 120_000;
    scheduler.fire();
    expect(target.abort).not.toHaveBeenCalled();

    // past the tool-stall window with no activity: the tool has hung
    clock.now = 180_001;
    scheduler.fire();
    expect(target.abort).toHaveBeenCalledTimes(1);
    expect(target.reason).toBeInstanceOf(ToolStreamStalledError);
  });

  it("heartbeats (does not abort) after a tool completes and the model then goes idle", () => {
    const clock: FakeClock = { now: 0 };
    const scheduler = new FakeScheduler();
    // model idle threshold 60s; tool stall 1_200s so the legitimate tool run
    // below (which completes at 600s) does not itself trip the tool-stall bound.
    const { watchdog, logger } = makeWatchdog(60_000, clock, scheduler, undefined, 1_200_000);

    watchdog.arm();
    const target = makeTarget();
    watchdog.beginAttempt(target);
    watchdog.observe(event(TOOL_CALLED));

    clock.now = 600_000; // long tool run, no abort
    scheduler.fire();
    expect(target.abort).not.toHaveBeenCalled();

    // tool finishes; we are now waiting on the model again
    clock.now = 600_001;
    watchdog.observe(event(TOOL_SUCCESS));

    // a bit of model streaming keeps it alive
    clock.now = 600_010;
    watchdog.observe(event(TEXT_DELTA));
    scheduler.fire();
    expect(target.abort).not.toHaveBeenCalled();
    expect(logger.warnings).toHaveLength(0);

    // now the model is idle: no events past the threshold. The watchdog
    // heartbeats and waits — it does NOT abort (opencode handles model waits).
    clock.now = 600_010 + 60_001;
    scheduler.fire();
    expect(target.abort).not.toHaveBeenCalled();
    expect(logger.warnings).toHaveLength(1);
    expect(logger.warnings[0]!.message).toMatch(/model idle past threshold/);
  });

  it("reschedules (does not abort) when activity keeps arriving within the window", () => {
    const clock: FakeClock = { now: 0 };
    const scheduler = new FakeScheduler();
    const { watchdog, logger } = makeWatchdog(60_000, clock, scheduler);

    watchdog.arm();
    const target = makeTarget();
    watchdog.beginAttempt(target);

    // tokens stream every 5s for a long time
    for (let t = 5_000; t < 5 * 60_000; t += 5_000) {
      clock.now = t;
      watchdog.observe(event(TEXT_DELTA));
      scheduler.fire(); // fires the rescheduled timer; idle is always ~5s < 60s
    }
    expect(target.abort).not.toHaveBeenCalled();
    expect(logger.warnings).toHaveLength(0);
  });

  it("does nothing when armed but no attempt has begun", () => {
    const clock: FakeClock = { now: 0 };
    const scheduler = new FakeScheduler();
    const { watchdog } = makeWatchdog(60_000, clock, scheduler);

    watchdog.arm();
    clock.now = 120_000;
    // no scheduled timer exists because beginAttempt was never called
    expect(scheduler.pending).toBeNull();
  });

  it("does not abort a previous attempt after endAttempt (sendWithRetry moved on)", () => {
    const clock: FakeClock = { now: 0 };
    const scheduler = new FakeScheduler();
    const { watchdog } = makeWatchdog(60_000, clock, scheduler);

    watchdog.arm();
    const target = makeTarget();
    watchdog.beginAttempt(target);
    watchdog.endAttempt();

    clock.now = 120_000;
    scheduler.fire();
    expect(target.abort).not.toHaveBeenCalled();
  });

  it("is inert while disarmed (observe has no effect)", () => {
    const clock: FakeClock = { now: 0 };
    const scheduler = new FakeScheduler();
    const { watchdog } = makeWatchdog(60_000, clock, scheduler);

    watchdog.arm();
    watchdog.disarm();
    const target = makeTarget();
    watchdog.beginAttempt(target);
    watchdog.observe(event(TOOL_CALLED));

    clock.now = 120_000;
    scheduler.fire();
    expect(target.abort).not.toHaveBeenCalled();
  });

  it("treats tool.input.* as model streaming (does not count as a running tool) and heartbeats past the threshold", () => {
    const clock: FakeClock = { now: 0 };
    const scheduler = new FakeScheduler();
    const { watchdog, logger } = makeWatchdog(60_000, clock, scheduler);

    watchdog.arm();
    const target = makeTarget();
    watchdog.beginAttempt(target);
    // the model is still producing the tool call input, not executing a tool
    watchdog.observe(event("session.next.tool.input.delta"));
    clock.now = 60_001;
    scheduler.fire();
    // pendingTools is 0 (only tool.called starts a tool), so the model-idle
    // threshold applies: the watchdog heartbeats (it does NOT abort).
    expect(target.abort).not.toHaveBeenCalled();
    expect(logger.warnings).toHaveLength(1);
  });

  it("defaults the tool-stall timeout to a multiple of the model-idle threshold", () => {
    const clock: FakeClock = { now: 0 };
    const scheduler = new FakeScheduler();
    const { watchdog } = makeWatchdog(60_000, clock, scheduler); // no explicit tool stall
    expect(watchdog.snapshot().toolStallTimeoutMs).toBe(60_000 * DEFAULT_TOOL_STALL_MULTIPLIER);
  });

  it("snapshot exposes the watchdog state for run-timeout diagnostics", () => {
    const clock: FakeClock = { now: 1_000 };
    const scheduler = new FakeScheduler();
    const { watchdog } = makeWatchdog(60_000, clock, scheduler, undefined, 180_000);

    // before arming: unarmed snapshot
    let snap = watchdog.snapshot();
    expect(snap.armed).toBe(false);
    expect(snap.idleMs).toBe(0);

    watchdog.arm();
    const target = makeTarget();
    watchdog.beginAttempt(target);
    watchdog.observe(event(TOOL_CALLED));

    clock.now = 70_000; // 69s of idle since the tool was dispatched
    snap = watchdog.snapshot();
    expect(snap.armed).toBe(true);
    expect(snap.pendingTools).toBe(1);
    expect(snap.idleMs).toBe(69_000);
    expect(snap.lastEventType).toBe(TOOL_CALLED);
    expect(snap.modelIdleThresholdMs).toBe(60_000);
    expect(snap.toolStallTimeoutMs).toBe(180_000);
  });
});

describe("cumulative model-idle budget", () => {
  it("heartbeats below the budget and aborts with ModelStreamStalledError once cumulative model-idle reaches it", () => {
    const clock: FakeClock = { now: 0 };
    const scheduler = new FakeScheduler();
    // threshold 60s, default budget 4x = 240s
    const { watchdog, logger } = makeWatchdog(60_000, clock, scheduler);

    watchdog.arm();
    const target = makeTarget();
    watchdog.beginAttempt(target);

    // three heartbeat windows: cumulative 60s/120s/180s, still below the budget
    clock.now = 60_001;
    scheduler.fire();
    clock.now = 120_001;
    scheduler.fire();
    clock.now = 180_001;
    scheduler.fire();
    expect(target.abort).not.toHaveBeenCalled();
    expect(logger.warnings.filter((w) => /model idle past threshold/.test(w.message))).toHaveLength(3);

    // fourth window: cumulative 240s reaches the budget — the stream is dead
    clock.now = 240_001;
    scheduler.fire();
    expect(target.abort).toHaveBeenCalledTimes(1);
    expect(target.reason).toBeInstanceOf(ModelStreamStalledError);
    expect(String(target.reason)).toMatch(/cumulative model-idle 240001ms exceeded the 240000ms budget/);
    expect(logger.warnings.some((w) => /cumulative model-idle budget exceeded/.test(w.message))).toBe(true);

    const snap = watchdog.snapshot();
    expect(snap.cumulativeModelIdleMs).toBe(240_001);
    expect(snap.maxCumulativeModelIdleMs).toBe(240_000);
  });

  it("keeps the cumulative budget across prompt attempts within the same run", () => {
    const clock: FakeClock = { now: 0 };
    const scheduler = new FakeScheduler();
    const { watchdog } = makeWatchdog(60_000, clock, scheduler, undefined, undefined, 120_000);

    watchdog.arm();
    const first = makeTarget();
    watchdog.beginAttempt(first);
    clock.now = 60_001;
    scheduler.fire(); // heartbeat, cumulative 60s
    clock.now = 120_001;
    scheduler.fire(); // cumulative 120s reaches the 120s budget -> abort
    expect(first.abort).toHaveBeenCalledTimes(1);
    expect(first.reason).toBeInstanceOf(ModelStreamStalledError);

    // the runner retries (sendWithRetry): a new attempt on the same watchdog.
    // The cumulative budget must persist — the retry aborts on its FIRST
    // threshold fire instead of getting a fresh budget.
    const second = makeTarget();
    watchdog.beginAttempt(second);
    clock.now = 180_001;
    scheduler.fire();
    expect(second.abort).toHaveBeenCalledTimes(1);
    expect(second.reason).toBeInstanceOf(ModelStreamStalledError);
    expect(watchdog.snapshot().cumulativeModelIdleMs).toBe(180_001);
  });

  it("does not accumulate idle for episodes that recover before the threshold", () => {
    const clock: FakeClock = { now: 0 };
    const scheduler = new FakeScheduler();
    const { watchdog } = makeWatchdog(60_000, clock, scheduler);

    watchdog.arm();
    const target = makeTarget();
    watchdog.beginAttempt(target);

    // many short episodes, each recovering just below the threshold — the
    // scheduler is never fired for them, and even if it were, sub-threshold
    // idle reschedules without accounting.
    for (let t = 30_000; t <= 600_000; t += 60_000) {
      clock.now = t;
      watchdog.observe(event(TEXT_DELTA));
      scheduler.fire(); // reschedules below the threshold, no accounting
    }
    expect(target.abort).not.toHaveBeenCalled();
    expect(watchdog.snapshot().cumulativeModelIdleMs).toBe(0);
  });

  it("does not count tool execution time toward the cumulative model-idle budget", () => {
    const clock: FakeClock = { now: 0 };
    const scheduler = new FakeScheduler();
    // threshold 60s, tool stall 600s, budget default 240s
    const { watchdog } = makeWatchdog(60_000, clock, scheduler, undefined, 600_000);

    watchdog.arm();
    const target = makeTarget();
    watchdog.beginAttempt(target);
    watchdog.observe(event(TOOL_CALLED));

    // a long quiet tool run: fires take the tool branch (defer), never the
    // model-idle accounting, even though total elapsed exceeds the budget.
    clock.now = 300_000;
    scheduler.fire();
    expect(target.abort).not.toHaveBeenCalled();

    clock.now = 300_001;
    watchdog.observe(event(TOOL_SUCCESS));

    // model phase after the tool: one threshold of idle accounts only itself
    clock.now = 360_002;
    scheduler.fire();
    expect(target.abort).not.toHaveBeenCalled();
    expect(watchdog.snapshot().cumulativeModelIdleMs).toBe(60_001);
  });
});

describe("TimeoutStallScheduler", () => {
  it("clears the real timer so it does not fire after clear", () => {
    vi.useFakeTimers();
    try {
      const fired = vi.fn();
      const scheduler = new TimeoutStallScheduler();
      const handle = scheduler.schedule(1_000, fired);
      handle.clear();
      vi.advanceTimersByTime(2_000);
      expect(fired).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
