import { describe, it, expect } from "vitest";

import { OpencodeSdkRunner } from "../src/infra/adapters/opencode/opencode-sdk-runner";
import type {
  OpencodeServerSpawner,
  OpencodeServerHandle,
  OpencodeClientFactory,
  OpencodePromptClient,
  OpencodeEvent,
  OpencodeEventSubscription,
} from "../src/infra/adapters/opencode/opencode-sdk-runner";
import type { RunActivityEmitter, RunActivityFrame } from "../src/infra/adapters/opencode/run-activity-emitter";
import type { OpencodeRunnerOptions } from "../src/domain/ports/out/opencode-runner";

class RecordingHandle implements OpencodeServerHandle {
  public killed = false;
  public constructor(public readonly port: number) {}
  public kill(): void {
    this.killed = true;
  }
  public diagnostics(): string {
    return "";
  }
}

class FakeSpawner implements OpencodeServerSpawner {
  public constructor(private readonly handle: RecordingHandle) {}
  public async spawn(_cwd: string, _port: number): Promise<OpencodeServerHandle> {
    return this.handle;
  }
}

class ProgrammableEventSubscription implements OpencodeEventSubscription {
  public closed = false;
  public readonly events: AsyncGenerator<OpencodeEvent>;
  public constructor(programmedEvents: readonly OpencodeEvent[]) {
    this.events = (async function* (): AsyncGenerator<OpencodeEvent> {
      for (const event of programmedEvents) {
        yield event;
      }
    })();
  }
  public close(): void {
    this.closed = true;
  }
}

// A prompt client whose prompt call blocks until release() is called, so the
// background activity consumer has time to drain the programmed events before
// runSession's finally block closes the subscription.
class StreamingPromptClient implements OpencodePromptClient {
  public subscribeCalls: string[] = [];
  public createSessionCalls = 0;
  public promptCalls = 0;
  public promptShouldThrow: Error | null = null;
  private releasePrompt: () => void = () => {};
  private promptPromise: Promise<void> = new Promise((resolve) => {
    this.releasePrompt = resolve;
  });

  public constructor(
    public readonly sessionId: string,
    public readonly eventSubscription: ProgrammableEventSubscription,
  ) {}

  public async createSession(): Promise<string> {
    this.createSessionCalls += 1;
    return this.sessionId;
  }

  public async prompt(
    _sessionId: string,
    _promptText: string,
    _options: OpencodeRunnerOptions,
    _schema?: object,
    signal?: AbortSignal,
  ): Promise<unknown> {
    this.promptCalls += 1;
    if (this.promptShouldThrow !== null) {
      throw this.promptShouldThrow;
    }
    if (signal !== undefined) {
      return new Promise((_resolve, reject) => {
        if (signal.aborted) {
          reject(new Error("aborted"));
          return;
        }
        signal.addEventListener("abort", () => reject(new Error("aborted")));
        this.promptPromise.then(() => _resolve(undefined));
      });
    }
    return this.promptPromise.then(() => undefined);
  }

  public async subscribeEvents(directory: string): Promise<OpencodeEventSubscription> {
    this.subscribeCalls.push(directory);
    return this.eventSubscription;
  }

  public release(): void {
    this.releasePrompt();
  }
}

class StreamingClientFactory implements OpencodeClientFactory {
  public constructor(private readonly client: StreamingPromptClient) {}
  public async create(): Promise<OpencodePromptClient> {
    return this.client;
  }
}

class RecordingEmitter implements RunActivityEmitter {
  public readonly frames: RunActivityFrame[] = [];
  public constructor(private readonly subscribers: boolean) {}
  public emit(frame: RunActivityFrame): void {
    this.frames.push(frame);
  }
  public hasSubscribers(): boolean {
    return this.subscribers;
  }
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

const BASE_OPTIONS: OpencodeRunnerOptions = {
  agentId: "codex",
  modelId: "zai-coding-plan/glm-5.2",
  runId: "run-42",
  consumerId: "consumer-7",
  maxInputRounds: 0,
};

describe("OpencodeSdkRunner activity streaming — unconditional forwarding", () => {
  it("forwards every matching event to emit unconditionally even when the emitter reports no subscribers", async () => {
    const sessionId = "sess-sink";
    const events: OpencodeEvent[] = [
      {
        type: "session.status",
        properties: { sessionID: sessionId, status: { type: "busy" } },
      },
      {
        type: "session.idle",
        properties: { sessionID: sessionId },
      },
    ];

    const handle = new RecordingHandle(45000);
    const spawner = new FakeSpawner(handle);
    const subscription = new ProgrammableEventSubscription(events);
    const client = new StreamingPromptClient(sessionId, subscription);
    const factory = new StreamingClientFactory(client);
    // The emitter reports NO subscribers, matching a run whose Activity section
    // nobody has opened. The runner must forward regardless: the broadcaster's
    // per-run routing (not the runner) decides whether a browser receives frames.
    const emitter = new RecordingEmitter(false);
    const runner = new OpencodeSdkRunner(spawner, factory, () => 45000, null, undefined, emitter);

    const runPromise = runner.run("/worktrees/feature-x", "fix the bug", BASE_OPTIONS);
    await tick();
    client.release();
    await runPromise;

    expect(client.subscribeCalls).toHaveLength(1);
    expect(emitter.frames).toHaveLength(2);
    expect(emitter.frames[0].kind).toBe("session.status");
    expect(emitter.frames[1].kind).toBe("session.idle");
    expect(handle.killed).toBe(true);
  });
});

describe("OpencodeSdkRunner activity streaming — forwarding", () => {
  it("forwards matching events to emit with the correct frame fields", async () => {
    const sessionId = "sess-matching";
    const events: OpencodeEvent[] = [
      {
        type: "session.status",
        properties: { sessionID: sessionId, status: { type: "busy" } },
      },
      {
        type: "message.part.updated",
        properties: {
          part: { sessionID: sessionId, type: "text", text: "hello" },
          delta: "hel",
        },
      },
    ];

    const handle = new RecordingHandle(45001);
    const spawner = new FakeSpawner(handle);
    const subscription = new ProgrammableEventSubscription(events);
    const client = new StreamingPromptClient(sessionId, subscription);
    const factory = new StreamingClientFactory(client);
    const emitter = new RecordingEmitter(true);
    const runner = new OpencodeSdkRunner(spawner, factory, () => 45001, null, undefined, emitter);

    const runPromise = runner.run("/worktrees/feature-x", "fix the bug", BASE_OPTIONS);
    await tick();
    client.release();
    await runPromise;

    expect(client.subscribeCalls).toEqual(["/worktrees/feature-x"]);
    expect(client.createSessionCalls).toBe(1);
    expect(emitter.frames).toHaveLength(2);

    const frame0 = emitter.frames[0];
    expect(frame0.runId).toBe("run-42");
    expect(frame0.consumerId).toBe("consumer-7");
    expect(frame0.sessionId).toBe(sessionId);
    expect(frame0.kind).toBe("session.status");
    expect(frame0.payload).toEqual({ sessionID: sessionId, status: { type: "busy" } });
    expect(new Date(frame0.at).toISOString()).toBe(frame0.at);

    const frame1 = emitter.frames[1];
    expect(frame1.kind).toBe("message.part.updated");
    expect(frame1.payload).toEqual({
      part: { sessionID: sessionId, type: "text", text: "hello" },
      delta: "hel",
    });
  });

  it("drops events whose session id does not match the created session", async () => {
    const matchingSession = "sess-match";
    const otherSession = "sess-other";
    const events: OpencodeEvent[] = [
      {
        type: "session.status",
        properties: { sessionID: otherSession, status: { type: "busy" } },
      },
      {
        type: "message.part.updated",
        properties: {
          part: { sessionID: otherSession, type: "text", text: "other session" },
        },
      },
      {
        type: "session.idle",
        properties: { sessionID: matchingSession },
      },
    ];

    const handle = new RecordingHandle(45002);
    const spawner = new FakeSpawner(handle);
    const subscription = new ProgrammableEventSubscription(events);
    const client = new StreamingPromptClient(matchingSession, subscription);
    const factory = new StreamingClientFactory(client);
    const emitter = new RecordingEmitter(true);
    const runner = new OpencodeSdkRunner(spawner, factory, () => 45002, null, undefined, emitter);

    const runPromise = runner.run("/wt", "x", BASE_OPTIONS);
    await tick();
    client.release();
    await runPromise;

    expect(emitter.frames).toHaveLength(1);
    expect(emitter.frames[0].sessionId).toBe(matchingSession);
    expect(emitter.frames[0].kind).toBe("session.idle");
  });

  it("extracts the session id from properties.part.sessionID for message.part.updated events", async () => {
    const sessionId = "sess-part";
    const events: OpencodeEvent[] = [
      {
        type: "message.part.updated",
        properties: {
          part: { sessionID: sessionId, type: "tool", tool: "bash" },
        },
      },
      {
        type: "message.part.removed",
        properties: {
          part: { sessionID: "wrong", type: "text" },
          sessionID: sessionId,
        },
      },
    ];

    const handle = new RecordingHandle(45003);
    const spawner = new FakeSpawner(handle);
    const subscription = new ProgrammableEventSubscription(events);
    const client = new StreamingPromptClient(sessionId, subscription);
    const factory = new StreamingClientFactory(client);
    const emitter = new RecordingEmitter(true);
    const runner = new OpencodeSdkRunner(spawner, factory, () => 45003, null, undefined, emitter);

    const runPromise = runner.run("/wt", "x", BASE_OPTIONS);
    await tick();
    client.release();
    await runPromise;

    // First event matches via part.sessionID; second does NOT match because
    // message.part.removed reads part.sessionID ("wrong"), not properties.sessionID.
    expect(emitter.frames).toHaveLength(1);
    expect(emitter.frames[0].kind).toBe("message.part.updated");
  });
});

describe("OpencodeSdkRunner activity streaming — teardown", () => {
  it("closes the subscription before killing the server when the prompt throws", async () => {
    const order: string[] = [];
    const handle = new RecordingHandle(45010);
    const originalKill = handle.kill.bind(handle);
    handle.kill = (): void => {
      order.push("kill");
      originalKill();
    };

    const spawner = new FakeSpawner(handle);
    const subscription = new ProgrammableEventSubscription([]);
    const originalClose = subscription.close.bind(subscription);
    subscription.close = (): void => {
      order.push("close");
      originalClose();
    };

    const client = new StreamingPromptClient("sess-1", subscription);
    client.promptShouldThrow = new Error("prompt blew up");
    const factory = new StreamingClientFactory(client);
    const emitter = new RecordingEmitter(true);
    const runner = new OpencodeSdkRunner(spawner, factory, () => 45010, null, undefined, emitter);

    await expect(
      runner.run("/wt", "x", BASE_OPTIONS),
    ).rejects.toThrow("prompt blew up");

    expect(subscription.closed).toBe(true);
    expect(handle.killed).toBe(true);
    expect(order.indexOf("close")).toBeLessThan(order.indexOf("kill"));
  });

  it("closes the subscription and kills the server on abort", async () => {
    const handle = new RecordingHandle(45011);

    const spawner = new FakeSpawner(handle);
    const subscription = new ProgrammableEventSubscription([]);

    const client = new StreamingPromptClient("sess-1", subscription);
    const factory = new StreamingClientFactory(client);
    const emitter = new RecordingEmitter(true);
    const runner = new OpencodeSdkRunner(spawner, factory, () => 45011, null, undefined, emitter);

    const controller = new AbortController();
    const promise = runner.run("/wt", "x", BASE_OPTIONS, controller.signal);

    await tick();
    controller.abort();

    await expect(promise).rejects.toThrow();
    await tick();

    expect(subscription.closed).toBe(true);
    expect(handle.killed).toBe(true);
  });
});

// A prompt call that stays open for `recoverAfterMs` (simulating opencode
// internally waiting/retrying while the model is temporarily unavailable — the
// same mechanism the opencode CLI relies on to wait for quota to resume), then
// resolves on its own. The runner must NOT abort and re-send it; it must let
// opencode recover.
class DelayedRecoveryPromptClient implements OpencodePromptClient {
  public promptCalls = 0;
  public subscribeCalls = 0;
  public constructor(
    public readonly sessionId: string,
    public readonly eventSubscription: OpencodeEventSubscription,
    private readonly recoverAfterMs: number,
  ) {}
  public async createSession(): Promise<string> {
    return this.sessionId;
  }
  public async subscribeEvents(_directory: string): Promise<OpencodeEventSubscription> {
    this.subscribeCalls += 1;
    return this.eventSubscription;
  }
  public async prompt(
    _sessionId: string,
    _promptText: string,
    _options: OpencodeRunnerOptions,
    _schema?: object,
    signal?: AbortSignal,
  ): Promise<unknown> {
    this.promptCalls += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({ ok: true }), this.recoverAfterMs);
      if (signal !== undefined) {
        if (signal.aborted) {
          clearTimeout(timer);
          reject(new Error("aborted"));
          return;
        }
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        }, { once: true });
      }
    });
  }
}

class StreamingClientFactory2 implements OpencodeClientFactory {
  public constructor(private readonly client: OpencodePromptClient) {}
  public async create(): Promise<OpencodePromptClient> {
    return this.client;
  }
}

// An event stream that never yields and never ends, so the consumer loop blocks
// waiting for events that never arrive (the watchdog sees no activity).
class PendingEventSubscription implements OpencodeEventSubscription {
  public closed = false;
  public readonly events: AsyncGenerator<OpencodeEvent> = (async function* (): AsyncGenerator<OpencodeEvent> {
    await new Promise<void>(() => {
      // never resolves
    });
  })();
  public close(): void {
    this.closed = true;
  }
}

describe("OpencodeSdkRunner stall watchdog integration", () => {
  it("does NOT retry the prompt when the model is silent; waits for opencode to recover (CLI parity)", async () => {
    const handle = new RecordingHandle(46000);
    const spawner = new FakeSpawner(handle);
    const subscription = new PendingEventSubscription();
    // opencode internally recovers after 150ms — past the 50ms model-idle
    // threshold. This mirrors a model that was temporarily unavailable (rate
    // limit, overload) and that opencode waited for, the way the CLI does.
    const client = new DelayedRecoveryPromptClient("sess-silent", subscription, 150);
    const factory = new StreamingClientFactory2(client);
    const runner = new OpencodeSdkRunner(spawner, factory, () => 46000, null, undefined, new RecordingEmitter(false), 50);

    // A bounded run signal is required: sendWithRetry's retry loop (and the
    // watchdog attempt wiring) only engage when a signal is present.
    const controller = new AbortController();
    const result = await runner.run("/wt", "fix the bug", BASE_OPTIONS, controller.signal);

    // The prompt is sent exactly once. The previous behaviour aborted and
    // re-sent it every model-idle threshold, discarding opencode's in-flight
    // retry and thrashing against the same unavailable model. Now we let
    // opencode handle the wait, as the CLI does.
    expect(client.promptCalls).toBe(1);
    expect(result).toBeUndefined();
    expect(handle.killed).toBe(true);
  }, 5_000);

  it("fails the run (no retry, server killed) when a tool stays in-flight with no activity past the tool-stall window", async () => {
    const handle = new RecordingHandle(46001);
    const spawner = new FakeSpawner(handle);
    // a tool was called and is "running" (never completes); no other events
    const subscription = new ProgrammableEventSubscription([
      { type: "session.next.tool.called", properties: { sessionID: "sess-tool" } },
    ]);
    // would succeed on attempt 2, but the tool stall must abort attempt 1 first
    const client = new DelayedRecoveryPromptClient("sess-tool", subscription, 10_000);
    const factory = new StreamingClientFactory2(client);
    // model idle threshold 50ms, tool stall 150ms
    const runner = new OpencodeSdkRunner(spawner, factory, () => 46001, null, undefined, new RecordingEmitter(false), 50, 150);

    const controller = new AbortController();
    const promise = runner.run("/wt", "run the tests", BASE_OPTIONS, controller.signal);

    // A tool hung in-flight past the tool-stall window: the watchdog aborts the
    // attempt with a tool-stall reason and sendWithRetry treats it as terminal
    // (the prompt is NOT retried). The run fails fast instead of waiting out
    // the 1h run timeout, and the spawned server is killed on the way out.
    await expect(promise).rejects.toThrow(/tool stream appeared stalled/);
    expect(client.promptCalls).toBe(1);
    expect(handle.killed).toBe(true);
  }, 5_000);
});
