import { UnexpectedStateError } from "../../../domain/exceptions/errors";
import type { Logger } from "../../../domain/ports/out/logger";
import { noopLogger } from "../../../domain/ports/out/logger";
import type { OpencodeEvent } from "./opencode-sdk-runner";

// An opencode agent run alternates between two phases:
//   1. waiting on the model (the LLM is producing the next turn), and
//   2. executing a tool the model requested (bash, edit, run-input, ...).
//
// When the model is temporarily unavailable (rate limit, overload, a dropped
// socket, a quota window), opencode itself waits and retries — the SAME logic
// the opencode CLI relies on to "wait for quota to resume" instead of giving
// up. A headless run should leverage that mechanism rather than fight it: if we
// abort the prompt and re-send it from scratch on our own short timer, we both
// discard opencode's in-flight retry state AND create a brand-new prompt that
// hits the same unavailable model — observed in production as a run that
// thrashes every 5 minutes for an hour and then times out anyway.
//
// So this watchdog NEVER aborts phase (1): a model-idle period past
// `modelIdleThresholdMs` only emits a heartbeat log so an operator can see the
// session is quiet, then reschedules. The prompt keeps running and lets
// opencode recover, exactly as the CLI would. The run's own AbortSignal (the
// 1h per-consumer run timeout) is the only thing that bounds a permanently
// dead model.
//
// Phase (2) is different: a running tool is exempt from the model-idle
// heartbeat, but NOT from a second, far longer `toolStallTimeoutMs`. If a tool
// has been in-flight (tool.called without a matching tool.success/tool.failed)
// and produced NO session activity for that long, the tool has hung (a bash
// command blocked on input, a deadlocked subagent, an MCP call that never
// returns). Re-sending the prompt while the opencode server may still be
// executing that tool is unsafe and pointless (the model would re-request it),
// so the watchdog DOES abort the attempt there with a ToolStreamStalledError,
// surfacing the hang as a fast, diagnosable failure instead of waiting out the
// run timeout.

// opencode event types that bracket tool execution. Sourced from
// @opencode-ai/sdk's Event union (session.next.tool.*). `tool.input.*` is the
// model *producing* the call (still model streaming) and is intentionally not
// counted — only `tool.called` (dispatched) starts a tool and only
// `tool.success` / `tool.failed` end it.
const TOOL_CALLED = "session.next.tool.called";
const TOOL_SUCCESS = "session.next.tool.success";
const TOOL_FAILED = "session.next.tool.failed";

// Default ratio of tool-stall timeout to model-idle threshold when a caller does
// not pass an explicit toolStallTimeoutMs. Keeps tests that shorten the model
// idle threshold proportional; production supplies a fixed 15m via the runner.
export const DEFAULT_TOOL_STALL_MULTIPLIER = 3;

// Default ratio of the cumulative model-idle budget to the model-idle threshold
// when a caller does not pass an explicit maxCumulativeModelIdleMs. Production
// default: 4 x 5m = 20m of total model-idle per run before the watchdog aborts
// the prompt attempt with ModelStreamStalledError.
export const DEFAULT_CUMULATIVE_IDLE_MULTIPLIER = 4;

/**
 * The reason placed on an attempt's AbortController when the watchdog aborts it
 * for a TOOL stall: a tool was dispatched (tool.called) and has stayed in-flight
 * with no session activity for `toolStallTimeoutMs`. This is a hung tool, not a
 * slow one — retrying the prompt is unsafe (the opencode server may still be
 * executing the tool) and pointless (the model would re-request it), so the
 * runner treats this abort as terminal and lets the run fail fast.
 */
export class ToolStreamStalledError extends UnexpectedStateError {
  public constructor(stallTimeoutMs: number) {
    super(
      `opencode tool stream appeared stalled: a tool was in-flight with no session activity for ${stallTimeoutMs}ms (tool.called without a matching tool.success/tool.failed)`,
    );
  }
}

/**
 * The reason placed on an attempt's AbortController when the watchdog aborts it
 * for a MODEL stall: cumulative model-idle time (waiting on the LLM, no tool in
 * flight) has exceeded the run's budget. Unlike a tool stall this is SAFE to
 * retry — no tool is executing, so re-sending the prompt cannot double-execute
 * anything — and unlike a single idle episode it means the provider stream is
 * dead rather than transiently unavailable (short episodes stay heartbeat-only
 * so opencode's own retry logic is never disturbed). The runner retries the
 * prompt a bounded number of times before letting this propagate as a terminal,
 * distinctly-named run failure.
 */
export class ModelStreamStalledError extends UnexpectedStateError {
  public constructor(
    maxCumulativeModelIdleMs: number,
    cumulativeModelIdleMs: number,
    episodeIdleMs: number,
  ) {
    super(
      `opencode model stream appeared stalled: cumulative model-idle ${cumulativeModelIdleMs}ms exceeded the ${maxCumulativeModelIdleMs}ms budget (current idle episode ${episodeIdleMs}ms, no tool in flight)`,
    );
  }
}

// Snapshot of the watchdog's observable state, emitted when a run is aborted so
// the timeout is self-diagnosing: pendingTools/idleMs/lastEventType distinguish
// a model-idle heartbeat, a hung tool, or an active loop at a glance;
// cumulativeModelIdleMs distinguishes a stalled run (large) from a busy one.
export interface StallWatchdogSnapshot {
  readonly armed: boolean;
  readonly pendingTools: number;
  readonly idleMs: number;
  readonly lastEventType: string | null;
  readonly modelIdleThresholdMs: number;
  readonly toolStallTimeoutMs: number;
  readonly cumulativeModelIdleMs: number;
  readonly maxCumulativeModelIdleMs: number;
}

// Minimal handle the watchdog needs to abort the in-flight prompt attempt. The
// runner passes its per-attempt controller (which also follows the run signal);
// the watchdog only ever aborts it, never reads its signal.
export interface StallAbortTarget {
  abort(reason?: unknown): void;
}

export interface StallWatchdogDeps {
  readonly clock?: () => number;
  readonly scheduler?: StallScheduler;
}

export interface StallScheduler {
  schedule(ms: number, fn: () => void): StallHandle;
}

export interface StallHandle {
  clear(): void;
}

export class TimeoutStallScheduler implements StallScheduler {
  public schedule(ms: number, fn: () => void): StallHandle {
    const handle = setTimeout(fn, ms);
    return { clear: () => clearTimeout(handle) };
  }
}

export class SessionStallWatchdog {
  private readonly clock: () => number;
  private readonly scheduler: StallScheduler;
  private readonly logger: Logger;
  private readonly modelIdleThresholdMs: number;
  private readonly toolStallTimeoutMs: number;
  private readonly maxCumulativeModelIdleMs: number;

  private lastActivityAt = 0;
  private pendingTools = 0;
  private lastEventType: string | null = null;
  private attempt: StallAbortTarget | null = null;
  private timer: StallHandle | null = null;
  private armed = false;

  // Cumulative model-idle accounting (persists across prompt attempts within a
  // run; reset only by disarm at run end). Only time spent in the model phase
  // (no tool in flight) with no session activity counts; idleEpisodeAccountedMs
  // tracks how much of the CURRENT idle episode has already been added, so each
  // fire accounts for exactly the newly-elapsed slice and a recovering episode
  // contributes nothing further.
  private cumulativeModelIdleMs = 0;
  private idleEpisodeAccountedMs = 0;

  public constructor(
    modelIdleThresholdMs: number,
    logger: Logger = noopLogger,
    deps: StallWatchdogDeps = {},
    // Upper bound on a single in-flight tool producing no activity. Defaults to
    // a multiple of the model-idle threshold so tests that shorten the threshold
    // get a proportionally shortened tool window; production passes an explicit
    // value.
    toolStallTimeoutMs: number = modelIdleThresholdMs * DEFAULT_TOOL_STALL_MULTIPLIER,
    // Total model-idle time allowed per run before the watchdog aborts the
    // prompt attempt with ModelStreamStalledError. Short idle episodes that
    // recover before the threshold never count (opencode's retry is left
    // undisturbed); only real dead air accumulates. Defaults to a multiple of
    // the threshold so tests that shorten the threshold get a proportionally
    // shortened budget.
    maxCumulativeModelIdleMs: number = modelIdleThresholdMs * DEFAULT_CUMULATIVE_IDLE_MULTIPLIER,
  ) {
    this.modelIdleThresholdMs = modelIdleThresholdMs;
    this.toolStallTimeoutMs = toolStallTimeoutMs;
    this.maxCumulativeModelIdleMs = maxCumulativeModelIdleMs;
    this.logger = logger;
    this.clock = deps.clock ?? Date.now;
    this.scheduler = deps.scheduler ?? new TimeoutStallScheduler();
  }

  // A run is only protected while armed. beginAttempt/endAttempt bracket each
  // prompt attempt so the watchdog never aborts a target that sendWithRetry
  // has already moved past.
  public arm(): void {
    this.armed = true;
    this.lastActivityAt = this.clock();
  }

  public disarm(): void {
    this.armed = false;
    this.clearTimer();
    this.attempt = null;
    this.pendingTools = 0;
    this.cumulativeModelIdleMs = 0;
    this.idleEpisodeAccountedMs = 0;
  }

  public beginAttempt(target: StallAbortTarget): void {
    this.attempt = target;
    this.pendingTools = 0;
    this.lastActivityAt = this.clock();
    // A new attempt starts a fresh idle episode; the cumulative budget
    // intentionally persists across attempts within the run.
    this.idleEpisodeAccountedMs = 0;
    this.schedule();
  }

  public endAttempt(): void {
    this.attempt = null;
    this.clearTimer();
  }

  public observe(event: OpencodeEvent): void {
    if (!this.armed) {
      return;
    }
    this.lastActivityAt = this.clock();
    this.lastEventType = event.type;
    this.idleEpisodeAccountedMs = 0;
    this.adjustToolBalance(event.type);
    // Reschedule so the deadline always tracks the most recent activity.
    if (this.attempt !== null) {
      this.schedule();
    }
  }

  private adjustToolBalance(type: string): void {
    if (type === TOOL_CALLED) {
      this.pendingTools = this.pendingTools + 1;
    } else if (type === TOOL_SUCCESS || type === TOOL_FAILED) {
      this.pendingTools = Math.max(0, this.pendingTools - 1);
    }
  }

  private schedule(): void {
    this.clearTimer();
    if (this.modelIdleThresholdMs <= 0 || this.attempt === null) {
      return;
    }
    this.timer = this.scheduler.schedule(this.modelIdleThresholdMs, () => this.onFire());
  }

  private onFire(): void {
    if (!this.armed || this.attempt === null) {
      return;
    }
    const idleMs = this.clock() - this.lastActivityAt;
    if (this.pendingTools > 0) {
      // A tool is in-flight. The model-idle clock does not apply, but a tool
      // that has produced NO activity for toolStallTimeoutMs has hung (no
      // tool.success/tool.failed will ever arrive). Abort the attempt so the
      // runner can fail the run fast instead of waiting out the 1h run timeout.
      if (idleMs >= this.toolStallTimeoutMs) {
        const controller = this.attempt;
        this.attempt = null;
        this.logger.warn("opencode-runner", "tool stream stall detected, aborting prompt attempt", {
          toolStallTimeoutMs: this.toolStallTimeoutMs,
          idleMs,
          pendingTools: this.pendingTools,
          lastEventType: this.lastEventType,
        });
        controller.abort(new ToolStreamStalledError(this.toolStallTimeoutMs));
        return;
      }
      // Tool still running within the allowed window: defer to the run timeout
      // and re-arm for the next window. A debug heartbeat keeps a long-running
      // tool visible in the logs when debug verbosity is enabled.
      this.logger.debug("opencode-runner", "tool still in-flight, deferring stall abort", {
        idleMs,
        pendingTools: this.pendingTools,
        toolStallTimeoutMs: this.toolStallTimeoutMs,
        lastEventType: this.lastEventType,
      });
      this.schedule();
      return;
    }
    if (idleMs < this.modelIdleThresholdMs) {
      this.schedule();
      return;
    }
    // The model has been idle past the threshold while no tool is running.
    // Account the newly-elapsed slice of this idle episode against the run's
    // cumulative budget. Short episodes that recover before the threshold never
    // reach this point, so opencode's retry logic for transient unavailability
    // (rate limit, overload, dropped socket) is never disturbed.
    const newlyIdleMs = idleMs - this.idleEpisodeAccountedMs;
    if (newlyIdleMs > 0) {
      this.cumulativeModelIdleMs = this.cumulativeModelIdleMs + newlyIdleMs;
      this.idleEpisodeAccountedMs = idleMs;
    }
    if (this.cumulativeModelIdleMs >= this.maxCumulativeModelIdleMs) {
      // The provider stream is dead, not transiently unavailable: total dead
      // air has exhausted the run's budget. Abort the prompt attempt with a
      // distinct ModelStreamStalledError — safe to retry (no tool is in
      // flight); the runner retries a bounded number of times before failing.
      const controller = this.attempt;
      this.attempt = null;
      this.logger.warn("opencode-runner", "cumulative model-idle budget exceeded, aborting prompt attempt", {
        maxCumulativeModelIdleMs: this.maxCumulativeModelIdleMs,
        cumulativeModelIdleMs: this.cumulativeModelIdleMs,
        episodeIdleMs: idleMs,
        lastEventType: this.lastEventType,
      });
      controller.abort(
        new ModelStreamStalledError(this.maxCumulativeModelIdleMs, this.cumulativeModelIdleMs, idleMs),
      );
      return;
    }
    // Below the cumulative budget this is NOT an abort condition. opencode
    // itself retries/waits when the model is temporarily unavailable (rate
    // limit, overload, dropped socket), the same mechanism the opencode CLI
    // relies on to wait for quota to resume. Aborting and re-sending the prompt
    // would discard that in-flight retry and create a new prompt that hits the
    // same unavailable model. Emit a heartbeat so an operator can see the
    // session is quiet, then keep waiting — either the model recovers or the
    // cumulative budget above / the run's own AbortSignal (the 1h per-consumer
    // run timeout) bounds a permanently dead model.
    this.logger.warn("opencode-runner", "model idle past threshold; opencode is handling it, waiting", {
      modelIdleThresholdMs: this.modelIdleThresholdMs,
      idleMs,
      cumulativeModelIdleMs: this.cumulativeModelIdleMs,
      maxCumulativeModelIdleMs: this.maxCumulativeModelIdleMs,
      lastEventType: this.lastEventType,
    });
    this.schedule();
  }

  // Captures the observable state for diagnostic logging when a run is aborted
  // (timeout or manual). Must be called before disarm(), which clears state.
  public snapshot(): StallWatchdogSnapshot {
    return {
      armed: this.armed,
      pendingTools: this.pendingTools,
      idleMs: this.armed ? this.clock() - this.lastActivityAt : 0,
      lastEventType: this.lastEventType,
      modelIdleThresholdMs: this.modelIdleThresholdMs,
      toolStallTimeoutMs: this.toolStallTimeoutMs,
      cumulativeModelIdleMs: this.cumulativeModelIdleMs,
      maxCumulativeModelIdleMs: this.maxCumulativeModelIdleMs,
    };
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      this.timer.clear();
      this.timer = null;
    }
  }
}
