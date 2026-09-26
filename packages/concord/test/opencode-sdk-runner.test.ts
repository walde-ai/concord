import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync } from "fs";
import { tmpdir } from "os";
import { createServer } from "net";
import path from "path";

import { OpencodeSdkRunner, ChildProcessOpencodeSpawner, HealthProbeRecorder, probeHealth, buildPromptBody, extractStructuredOutput, isRetryablePromptFailure, retryDelayMs } from "../src/infra/adapters/opencode/opencode-sdk-runner";
import { noopLogger } from "../src/domain/ports/out/logger";
import type {
  OpencodeServerSpawner,
  OpencodeServerHandle,
  OpencodeClientFactory,
  OpencodePromptClient,
  OpencodeEvent,
  OpencodeEventSubscription,
} from "../src/infra/adapters/opencode/opencode-sdk-runner";
import type { BinaryResolver } from "../src/infra/adapters/system/binary-resolver";
import type { OpencodeRunnerOptions } from "../src/domain/ports/out/opencode-runner";
import { UnexpectedStateError } from "../src/domain/exceptions/errors";
import type { RunMcpBackend, RunMcpBackendFactory } from "../src/infra/adapters/opencode/run-input-mcp-server";
import type { RequestRunInput } from "../src/domain/ports/in/request-run-input";
import type { RecordRunUpdate } from "../src/domain/ports/in/record-run-update";
import type { RunUpdate } from "../src/domain/entities/run-update";

class RecordingHandle implements OpencodeServerHandle {
  public killed = false;
  public diagnosticsOutput = "";
  public constructor(public readonly port: number) {}
  public kill(): void {
    this.killed = true;
  }
  public diagnostics(): string {
    return this.diagnosticsOutput;
  }
}

class FakeSpawner implements OpencodeServerSpawner {
  public readonly spawns: Array<{ cwd: string; port: number; env?: Record<string, string> }> = [];
  public constructor(private readonly handle: RecordingHandle) {}
  public async spawn(cwd: string, port: number, env?: Record<string, string>): Promise<OpencodeServerHandle> {
    this.spawns.push({ cwd, port, env });
    return this.handle;
  }
}

interface RecordedSend {
  readonly sessionId: string;
  readonly prompt: string;
  readonly options: OpencodeRunnerOptions;
  readonly schema?: object;
  readonly signal?: AbortSignal;
}

class FakePromptClient implements OpencodePromptClient {
  public readonly calls: RecordedSend[] = [];
  public constructor(private readonly output: unknown) {}
  public async createSession(): Promise<string> {
    return "session-fake";
  }
  public async prompt(sessionId: string, prompt: string, options: OpencodeRunnerOptions, schema?: object, signal?: AbortSignal): Promise<unknown> {
    this.calls.push({ sessionId, prompt, options, schema, signal });
    return this.output;
  }
  public async subscribeEvents(_directory: string): Promise<OpencodeEventSubscription> {
    return noOpEventSubscription();
  }
}

function noOpEventSubscription(): OpencodeEventSubscription {
  async function* empty(): AsyncGenerator<OpencodeEvent> {}
  return {
    events: empty(),
    close: () => {},
  };
}

class FakeClientFactory implements OpencodeClientFactory {
  public readonly creates: Array<{ baseUrl: string }> = [];
  public constructor(private readonly client: FakePromptClient) {}
  public async create(baseUrl: string): Promise<OpencodePromptClient> {
    this.creates.push({ baseUrl });
    return this.client;
  }
}

describe("OpencodeSdkRunner.run", () => {
  it("spawns the server, sends the prompt with the per-call options, and tears it down", async () => {
    const handle = new RecordingHandle(44000);
    const spawner = new FakeSpawner(handle);
    const client = new FakePromptClient(undefined);
    const factory = new FakeClientFactory(client);
    const runner = new OpencodeSdkRunner(spawner, factory, () => 44000);

    await runner.run("/worktrees/feature-x", "fix the bug", { agentId: "codex", modelId: "anthropic/claude-sonnet-4.5", runId: "run-1", consumerId: "c-1", maxInputRounds: 0 });

    expect(spawner.spawns).toHaveLength(1);
    expect(spawner.spawns[0].cwd).toBe("/worktrees/feature-x");
    expect(spawner.spawns[0].port).toBe(44000);
    expect(factory.creates).toEqual([{ baseUrl: "http://127.0.0.1:44000" }]);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].prompt).toBe("fix the bug");
    expect(client.calls[0].options).toEqual({ agentId: "codex", modelId: "anthropic/claude-sonnet-4.5", runId: "run-1", consumerId: "c-1", maxInputRounds: 0 });
    expect(handle.killed).toBe(true);
  });

  it("kills the server even if the client throws", async () => {
    const handle = new RecordingHandle(44001);
    const spawner = new FakeSpawner(handle);
    const client = new FakePromptClient(undefined);
    client.prompt = async () => {
      throw new Error("agent blew up");
    };
    const factory = new FakeClientFactory(client);
    const runner = new OpencodeSdkRunner(spawner, factory, () => 44001);

    await expect(
      runner.run("/worktrees/feature-x", "x", { agentId: "opencode", modelId: "zai-coding-plan/glm-5.2", runId: "run-1", consumerId: "c-1", maxInputRounds: 0 }),
    ).rejects.toThrow("agent blew up");
    expect(handle.killed).toBe(true);
  });

  it("fails fast with a clear error when no agent is configured", async () => {
    const handle = new RecordingHandle(44002);
    const spawner = new FakeSpawner(handle);
    const client = new FakePromptClient(undefined);
    const factory = new FakeClientFactory(client);
    const runner = new OpencodeSdkRunner(spawner, factory, () => 44002);

    await expect(
      runner.run("/worktrees/feature-x", "x", { agentId: "", modelId: "zai-coding-plan/glm-5.2", runId: "run-1", consumerId: "c-1", maxInputRounds: 0 }),
    ).rejects.toThrow(/no agent configured/);
    // must not spawn opencode for a misconfigured consumer
    expect(spawner.spawns).toHaveLength(0);
  });

  it("fails fast with a clear error when no model is configured", async () => {
    const handle = new RecordingHandle(44002);
    const spawner = new FakeSpawner(handle);
    const client = new FakePromptClient(undefined);
    const factory = new FakeClientFactory(client);
    const runner = new OpencodeSdkRunner(spawner, factory, () => 44002);

    await expect(
      runner.run("/worktrees/feature-x", "x", { agentId: "build", modelId: "", runId: "run-1", consumerId: "c-1", maxInputRounds: 0 }),
    ).rejects.toThrow(/no model configured/);
    expect(spawner.spawns).toHaveLength(0);
  });

  it("splits a provider/model value into providerID and modelID", async () => {
    const handle = new RecordingHandle(44003);
    const spawner = new FakeSpawner(handle);
    const client = new FakePromptClient(undefined);
    const factory = new FakeClientFactory(client);
    const runner = new OpencodeSdkRunner(spawner, factory, () => 44003);

    await runner.run("/worktrees/feature-x", "x", { agentId: "build", modelId: "openai/gpt-4o", runId: "run-1", consumerId: "c-1", maxInputRounds: 0 });

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].options).toEqual({ agentId: "build", modelId: "openai/gpt-4o", runId: "run-1", consumerId: "c-1", maxInputRounds: 0 });
  });

  it("treats a modelId without a slash as modelID with empty providerID", async () => {
    const handle = new RecordingHandle(44004);
    const spawner = new FakeSpawner(handle);
    const client = new FakePromptClient(undefined);
    const factory = new FakeClientFactory(client);
    const runner = new OpencodeSdkRunner(spawner, factory, () => 44004);

    await runner.run("/worktrees/feature-x", "x", { agentId: "build", modelId: "local-model", runId: "run-1", consumerId: "c-1", maxInputRounds: 0 });

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].options.modelId).toBe("local-model");
  });
});

describe("OpencodeSdkRunner.runStructured", () => {
  it("forwards the schema and returns the structured output", async () => {
    const handle = new RecordingHandle(44010);
    const spawner = new FakeSpawner(handle);
    const client = new FakePromptClient({ verdict: "approved", summary: "ok" });
    const factory = new FakeClientFactory(client);
    const runner = new OpencodeSdkRunner(spawner, factory, () => 44010);

    const schema = { type: "object", properties: { verdict: { type: "string" } } };
    const output = await runner.runStructured("/worktrees/feature-x", "review this", schema, {
      agentId: "codex",
      modelId: "zai-coding-plan/glm-5.2",
      runId: "run-1",
      consumerId: "c-1",
      maxInputRounds: 0,
    });

    expect(output).toEqual({ verdict: "approved", summary: "ok" });
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].schema).toBe(schema);
    expect(client.calls[0].options.agentId).toBe("codex");
    expect(handle.killed).toBe(true);
  });
});

describe("OpencodeSdkRunner githubToken transport", () => {
  it("passes a GIT_CONFIG_* env overlay encoding the token when githubToken is set", async () => {
    const handle = new RecordingHandle(44020);
    const spawner = new FakeSpawner(handle);
    const client = new FakePromptClient(undefined);
    const factory = new FakeClientFactory(client);
    const runner = new OpencodeSdkRunner(spawner, factory, () => 44020);

    await runner.run("/wt", "x", { agentId: "opencode", modelId: "zai-coding-plan/glm-5.2", runId: "run-1", consumerId: "c-1", maxInputRounds: 0, githubToken: "tok-123" });

    expect(spawner.spawns).toHaveLength(1);
    const env = spawner.spawns[0].env;
    expect(env).toBeDefined();
    expect(env!.GIT_CONFIG_COUNT).toBe("1");
    expect(env!.GIT_CONFIG_KEY_0).toBe("http.https://github.com/.extraheader");
    const decoded = Buffer.from(
      env!.GIT_CONFIG_VALUE_0.replace("AUTHORIZATION: basic ", ""),
      "base64",
    ).toString("utf8");
    expect(decoded).toBe("x-access-token:tok-123");
  });

  it("passes no GIT_CONFIG overlay when githubToken is absent", async () => {
    const handle = new RecordingHandle(44021);
    const spawner = new FakeSpawner(handle);
    const client = new FakePromptClient(undefined);
    const factory = new FakeClientFactory(client);
    const runner = new OpencodeSdkRunner(spawner, factory, () => 44021);

    await runner.run("/wt", "x", { agentId: "opencode", modelId: "zai-coding-plan/glm-5.2", runId: "run-1", consumerId: "c-1", maxInputRounds: 0 });

    expect(spawner.spawns).toHaveLength(1);
    const env = spawner.spawns[0].env;
    // No token means no GIT_CONFIG_* keys. The env is still present because the
    // permission pre-approval inline config is always injected (see below).
    expect(env).toBeDefined();
    expect(env!.GIT_CONFIG_COUNT).toBeUndefined();
    expect(JSON.parse(env!.OPENCODE_CONFIG_CONTENT).permission).toBe("allow");
  });

  it("passes no GIT_CONFIG overlay when githubToken is empty", async () => {
    const handle = new RecordingHandle(44022);
    const spawner = new FakeSpawner(handle);
    const client = new FakePromptClient(undefined);
    const factory = new FakeClientFactory(client);
    const runner = new OpencodeSdkRunner(spawner, factory, () => 44022);

    await runner.run("/wt", "x", { agentId: "opencode", modelId: "zai-coding-plan/glm-5.2", runId: "run-1", consumerId: "c-1", maxInputRounds: 0, githubToken: "" });

    const env = spawner.spawns[0].env;
    expect(env).toBeDefined();
    expect(env!.GIT_CONFIG_COUNT).toBeUndefined();
    expect(JSON.parse(env!.OPENCODE_CONFIG_CONTENT).permission).toBe("allow");
  });
});

describe("OpencodeSdkRunner permission pre-approval", () => {
  it("pre-approves all permissions even with no token and no wiring, so a headless run is never gated on permission.asked", async () => {
    // Regression guard for a github-failure-fix run that timed out at the 1h
    // hard limit: the agent ran `rm -f /tmp/mock-trace.log`, opencode emitted
    // permission.asked (a destructive command on a path outside the project's
    // external-directory allowlist), and the headless run blocked for ~44
    // minutes with no human to answer. The fix injects permission:"allow" into
    // the inline config for every spawn, including this minimal no-token /
    // no-wiring case which previously produced no env overlay at all.
    const handle = new RecordingHandle(44030);
    const spawner = new FakeSpawner(handle);
    const client = new FakePromptClient(undefined);
    const factory = new FakeClientFactory(client);
    const runner = new OpencodeSdkRunner(spawner, factory, () => 44030);

    await runner.run("/wt", "x", { agentId: "opencode", modelId: "zai-coding-plan/glm-5.2", runId: "run-1", consumerId: "c-1", maxInputRounds: 0 });

    const env = spawner.spawns[0].env;
    expect(env).toBeDefined();
    const config = JSON.parse(env!.OPENCODE_CONFIG_CONTENT);
    expect(config.permission).toBe("allow");
  });
});

describe("OpencodeSdkRunner abort handling", () => {
  class AbortAwarePromptClient implements OpencodePromptClient {
    public readonly calls: RecordedSend[] = [];
    public async createSession(): Promise<string> {
      return "session-fake";
    }
    public async prompt(sessionId: string, prompt: string, options: OpencodeRunnerOptions, schema?: object, signal?: AbortSignal): Promise<unknown> {
      this.calls.push({ sessionId, prompt, options, schema, signal });
      return new Promise<unknown>((resolve, reject) => {
        if (signal === undefined) {
          resolve(undefined);
          return;
        }
        if (signal.aborted) {
          reject(new Error("aborted"));
          return;
        }
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }
    public async subscribeEvents(_directory: string): Promise<OpencodeEventSubscription> {
      return noOpEventSubscription();
    }
  }

  const nextTick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  it("forwards the abort signal to the prompt call", async () => {
    const handle = new RecordingHandle(44030);
    const spawner = new FakeSpawner(handle);
    const client = new AbortAwarePromptClient();
    const factory = new FakeClientFactory(client);
    const runner = new OpencodeSdkRunner(spawner, factory, () => 44030);

    const controller = new AbortController();
    const promise = runner.run("/wt", "x", { agentId: "opencode", modelId: "zai-coding-plan/glm-5.2", runId: "run-1", consumerId: "c-1", maxInputRounds: 0 }, controller.signal);

    await nextTick();
    expect(client.calls).toHaveLength(1);
    // The prompt runs under a per-attempt signal (so the stall watchdog can
    // abort just this attempt), not the run signal itself; but it must follow
    // the run signal — aborting the run aborts the in-flight prompt.
    const promptSignal = client.calls[0].signal;
    expect(promptSignal).not.toBe(controller.signal);
    expect(promptSignal?.aborted).toBe(false);

    controller.abort();
    await expect(promise).rejects.toThrow("aborted");
    expect(promptSignal?.aborted).toBe(true);
    expect(handle.killed).toBe(true);
  });

  it("kills the spawned server when the signal aborts mid-session", async () => {
    const handle = new RecordingHandle(44031);
    const spawner = new FakeSpawner(handle);
    const client = new AbortAwarePromptClient();
    const factory = new FakeClientFactory(client);
    const runner = new OpencodeSdkRunner(spawner, factory, () => 44031);

    const controller = new AbortController();
    const promise = runner.run("/wt", "x", { agentId: "opencode", modelId: "zai-coding-plan/glm-5.2", runId: "run-1", consumerId: "c-1", maxInputRounds: 0 }, controller.signal);

    await nextTick();
    expect(handle.killed).toBe(false);

    controller.abort();
    await expect(promise).rejects.toThrow("aborted");
    expect(handle.killed).toBe(true);
  });

  it("rejects without starting a session when the signal is already aborted", async () => {
    const handle = new RecordingHandle(44032);
    const spawner = new FakeSpawner(handle);
    const client = new AbortAwarePromptClient();
    const factory = new FakeClientFactory(client);
    const runner = new OpencodeSdkRunner(spawner, factory, () => 44032);

    const controller = new AbortController();
    controller.abort();

    await expect(
      runner.run("/wt", "x", { agentId: "opencode", modelId: "zai-coding-plan/glm-5.2", runId: "run-1", consumerId: "c-1", maxInputRounds: 0 }, controller.signal),
    ).rejects.toThrow("aborted before start");
    expect(handle.killed).toBe(true);
    expect(client.calls).toHaveLength(0);
  });
});

describe("OpencodeSdkRunner mid-session failure diagnostics", () => {
  it("enriches a client.prompt failure with the spawned server's diagnostics so the cause is not lost", async () => {
    const handle = new RecordingHandle(44040);
    handle.diagnosticsOutput = "process exited with code 137; signal: Killed";
    const spawner = new FakeSpawner(handle);
    const client = new FakePromptClient(undefined);
    client.prompt = async () => {
      throw new Error("fetch failed");
    };
    const factory = new FakeClientFactory(client);
    const runner = new OpencodeSdkRunner(spawner, factory, () => 44040);

    await expect(
      runner.run("/wt", "x", { agentId: "opencode", modelId: "zai-coding-plan/glm-5.2", runId: "run-1", consumerId: "c-1", maxInputRounds: 0 }),
    ).rejects.toThrow(/fetch failed.*process exited with code 137/);
    expect(handle.killed).toBe(true);
  });

  it("rethrows the original error unchanged when the server exposes no diagnostics", async () => {
    const handle = new RecordingHandle(44041);
    const spawner = new FakeSpawner(handle);
    const client = new FakePromptClient(undefined);
    client.prompt = async () => {
      throw new Error("agent blew up");
    };
    const factory = new FakeClientFactory(client);
    const runner = new OpencodeSdkRunner(spawner, factory, () => 44041);

    await expect(
      runner.run("/wt", "x", { agentId: "opencode", modelId: "zai-coding-plan/glm-5.2", runId: "run-1", consumerId: "c-1", maxInputRounds: 0 }),
    ).rejects.toThrow("agent blew up");
    expect(handle.killed).toBe(true);
  });

  it("surfaces the full error cause chain (e.g. the undici error behind a fetch failed)", async () => {
    const handle = new RecordingHandle(44042);
    handle.diagnosticsOutput = "server still listening";
    const spawner = new FakeSpawner(handle);
    const client = new FakePromptClient(undefined);
    client.prompt = async () => {
      throw new Error("fetch failed", { cause: new Error("Headers Timeout Expired") });
    };
    const factory = new FakeClientFactory(client);
    const runner = new OpencodeSdkRunner(spawner, factory, () => 44042);

    await expect(
      runner.run("/wt", "x", { agentId: "opencode", modelId: "zai-coding-plan/glm-5.2", runId: "run-1", consumerId: "c-1", maxInputRounds: 0 }),
    ).rejects.toThrow(/fetch failed.*Headers Timeout Expired/);
    expect(handle.killed).toBe(true);
  });
});

class ScriptedPromptClient implements OpencodePromptClient {
  public readonly calls: RecordedSend[] = [];
  public constructor(private readonly script: Array<unknown | Error>) {}
  public async createSession(): Promise<string> {
    return "session-fake";
  }
  public async prompt(sessionId: string, prompt: string, options: OpencodeRunnerOptions, schema?: object, signal?: AbortSignal): Promise<unknown> {
    this.calls.push({ sessionId, prompt, options, schema, signal });
    const index = this.calls.length - 1;
    if (index >= this.script.length) {
      throw new Error(`ScriptedPromptClient: no scripted response at index ${index}`);
    }
    const next = this.script[index];
    if (next instanceof Error) {
      throw next;
    }
    return next;
  }
  public async subscribeEvents(_directory: string): Promise<OpencodeEventSubscription> {
    return noOpEventSubscription();
  }
}

describe("OpencodeSdkRunner prompt retry", () => {
  it("retries a transient network failure and succeeds on a later attempt", async () => {
    vi.useFakeTimers();
    try {
      const handle = new RecordingHandle(44050);
      const spawner = new FakeSpawner(handle);
      const client = new ScriptedPromptClient([new Error("fetch failed"), "ok"]);
      const factory = new FakeClientFactory(client);
      const runner = new OpencodeSdkRunner(spawner, factory, () => 44050);

      const controller = new AbortController();
      const promise = runner.run("/wt", "x", { agentId: "opencode", modelId: "zai-coding-plan/glm-5.2", runId: "r", consumerId: "c", maxInputRounds: 0 }, controller.signal);

      await vi.advanceTimersByTimeAsync(0);
      expect(client.calls).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(2_000);
      await vi.advanceTimersByTimeAsync(0);
      expect(client.calls).toHaveLength(2);

      await expect(promise).resolves.toBeUndefined();
      expect(handle.killed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry when there is no signal (fails fast, preserving prior behaviour)", async () => {
    const handle = new RecordingHandle(44051);
    const spawner = new FakeSpawner(handle);
    const client = new ScriptedPromptClient([new Error("fetch failed"), "ok"]);
    const factory = new FakeClientFactory(client);
    const runner = new OpencodeSdkRunner(spawner, factory, () => 44051);

    await expect(
      runner.run("/wt", "x", { agentId: "opencode", modelId: "zai-coding-plan/glm-5.2", runId: "r", consumerId: "c", maxInputRounds: 0 }),
    ).rejects.toThrow(/fetch failed/);
    expect(client.calls).toHaveLength(1);
    expect(handle.killed).toBe(true);
  });

  it("does not retry a non-transient error even with a signal", async () => {
    const handle = new RecordingHandle(44052);
    const spawner = new FakeSpawner(handle);
    const client = new ScriptedPromptClient([new Error("agent blew up"), "ok"]);
    const factory = new FakeClientFactory(client);
    const runner = new OpencodeSdkRunner(spawner, factory, () => 44052);

    const controller = new AbortController();
    await expect(
      runner.run("/wt", "x", { agentId: "opencode", modelId: "zai-coding-plan/glm-5.2", runId: "r", consumerId: "c", maxInputRounds: 0 }, controller.signal),
    ).rejects.toThrow("agent blew up");
    expect(client.calls).toHaveLength(1);
    expect(handle.killed).toBe(true);
  });

  it("stops retrying when the signal aborts during the backoff delay", async () => {
    vi.useFakeTimers();
    try {
      const handle = new RecordingHandle(44053);
      const spawner = new FakeSpawner(handle);
      const client = new ScriptedPromptClient([new Error("fetch failed"), "ok"]);
      const factory = new FakeClientFactory(client);
      const runner = new OpencodeSdkRunner(spawner, factory, () => 44053);

      const controller = new AbortController();
      const promise = runner.run("/wt", "x", { agentId: "opencode", modelId: "zai-coding-plan/glm-5.2", runId: "r", consumerId: "c", maxInputRounds: 0 }, controller.signal);

      await vi.advanceTimersByTimeAsync(0);
      expect(client.calls).toHaveLength(1);

      // Abort during the 2s backoff delay, before the timer fires. Attach the
      // rejection handler before yielding so the rejection is never unhandled.
      controller.abort();
      await expect(promise).rejects.toThrow(/aborted/);

      expect(client.calls).toHaveLength(1);
      expect(handle.killed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries an empty model-API response (returned no message) and succeeds", async () => {
    vi.useFakeTimers();
    try {
      const handle = new RecordingHandle(44054);
      const spawner = new FakeSpawner(handle);
      const client = new ScriptedPromptClient([
        new UnexpectedStateError("Opencode session.prompt returned no message (HTTP 502): no error body"),
        "ok",
      ]);
      const factory = new FakeClientFactory(client);
      const runner = new OpencodeSdkRunner(spawner, factory, () => 44054);

      const controller = new AbortController();
      const promise = runner.run("/wt", "x", { agentId: "opencode", modelId: "zai-coding-plan/glm-5.2", runId: "r", consumerId: "c", maxInputRounds: 0 }, controller.signal);

      await vi.advanceTimersByTimeAsync(0);
      expect(client.calls).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(2_000);
      await vi.advanceTimersByTimeAsync(0);

      await expect(promise).resolves.toBeUndefined();
      expect(client.calls).toHaveLength(2);
      expect(handle.killed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("isRetryablePromptFailure", () => {
  it("retries network errors (fetch failed, ECONNREFUSED, DNS, timeout)", () => {
    expect(isRetryablePromptFailure(new Error("fetch failed"), undefined)).toBe(true);
    expect(isRetryablePromptFailure(new Error("connect ECONNREFUSED 127.0.0.1:443"), undefined)).toBe(true);
    expect(isRetryablePromptFailure(new Error("getaddrinfo EAI_AGAIN api.github.com"), undefined)).toBe(true);
    expect(isRetryablePromptFailure(new Error("Connect Timeout Error"), undefined)).toBe(true);
    expect(isRetryablePromptFailure(new Error("other side closed"), undefined)).toBe(true);
  });

  it("retries errors found in the cause chain", () => {
    const cause = new TypeError("fetch failed", { cause: new Error("ECONNRESET") });
    expect(isRetryablePromptFailure(cause, undefined)).toBe(true);
  });

  it("retries empty opencode responses only when there is no error body (transient model-API swallow)", () => {
    // no payload AND no error body -> the model-API blip opencode swallowed -> retry
    expect(isRetryablePromptFailure(new UnexpectedStateError("Opencode session.prompt returned no message (HTTP 502): no error body"), undefined)).toBe(true);
    expect(isRetryablePromptFailure(new UnexpectedStateError("Opencode session.create returned no data (HTTP 502): no error body"), undefined)).toBe(true);
  });

  it("does not retry a deterministic opencode 5xx that carries a real error body (e.g. UnknownError)", () => {
    // opencode itself failed (unknown agent, etc.) -> 5xx WITH a JSON body -> deterministic, must not loop
    expect(isRetryablePromptFailure(new UnexpectedStateError('Opencode session.prompt returned no message (HTTP 500): {"name":"UnknownError","data":{"message":"Unexpected server error"}}'), undefined)).toBe(false);
    expect(isRetryablePromptFailure(new UnexpectedStateError("Opencode session.prompt returned no message (HTTP 500)"), undefined)).toBe(false);
  });

  it("does not retry abort errors (DOMException)", () => {
    expect(isRetryablePromptFailure(new DOMException("aborted", "AbortError"), undefined)).toBe(false);
  });

  it("does not retry when the signal is already aborted", () => {
    const controller = new AbortController();
    controller.abort();
    expect(isRetryablePromptFailure(new Error("fetch failed"), controller.signal)).toBe(false);
  });

  it("does not retry non-transient errors or deterministic UnexpectedStateErrors", () => {
    expect(isRetryablePromptFailure(new Error("agent blew up"), undefined)).toBe(false);
    expect(isRetryablePromptFailure(new UnexpectedStateError("Opencode produced no StructuredOutput tool call"), undefined)).toBe(false);
  });
});

describe("retryDelayMs", () => {
  it("uses exponential backoff capped at the max", () => {
    expect(retryDelayMs(0)).toBe(2_000);
    expect(retryDelayMs(1)).toBe(4_000);
    expect(retryDelayMs(2)).toBe(8_000);
    expect(retryDelayMs(3)).toBe(16_000);
    expect(retryDelayMs(4)).toBe(32_000);
    expect(retryDelayMs(5)).toBe(60_000);
    expect(retryDelayMs(10)).toBe(60_000);
  });
});

class FlakySpawner implements OpencodeServerSpawner {
  public readonly spawns: Array<{ cwd: string; port: number; env?: Record<string, string> }> = [];
  public lastHandle: RecordingHandle | null = null;
  public constructor(private readonly failuresBeforeSuccess: number) {}

  public async spawn(cwd: string, port: number, env?: Record<string, string>): Promise<OpencodeServerHandle> {
    this.spawns.push({ cwd, port, env });
    if (this.spawns.length <= this.failuresBeforeSuccess) {
      throw new Error(`port ${port} was busy`);
    }
    this.lastHandle = new RecordingHandle(port);
    return this.lastHandle;
  }
}

describe("OpencodeSdkRunner spawn retry", () => {
  it("retries with a fresh port when the server fails to become healthy and succeeds on a later attempt", async () => {
    let nextPort = 50000;
    const allocator = (): number => {
      nextPort = nextPort + 1;
      return nextPort;
    };
    const spawner = new FlakySpawner(2);
    const client = new FakePromptClient(undefined);
    const factory = new FakeClientFactory(client);
    const runner = new OpencodeSdkRunner(spawner, factory, allocator);

    await runner.run("/wt", "x", { agentId: "opencode", modelId: "zai-coding-plan/glm-5.2", runId: "run-1", consumerId: "c-1", maxInputRounds: 0 });

    expect(spawner.spawns).toHaveLength(3);
    expect(spawner.spawns.map((entry) => entry.port)).toEqual([50001, 50002, 50003]);
    expect(factory.creates).toEqual([{ baseUrl: "http://127.0.0.1:50003" }]);
    expect(client.calls).toHaveLength(1);
    expect(spawner.lastHandle!.killed).toBe(true);
  });

  it("gives up after repeated failures and surfaces the underlying error", async () => {
    const spawner = new FlakySpawner(1000);
    const client = new FakePromptClient(undefined);
    const factory = new FakeClientFactory(client);
    const runner = new OpencodeSdkRunner(spawner, factory, () => 50050);

    await expect(
      runner.run("/wt", "x", { agentId: "opencode", modelId: "zai-coding-plan/glm-5.2", runId: "run-1", consumerId: "c-1", maxInputRounds: 0 }),
    ).rejects.toThrow("did not become healthy after 3 attempts");
    expect(spawner.spawns).toHaveLength(3);
    expect(client.calls).toHaveLength(0);
  });
});

class FixedBinaryResolver implements BinaryResolver {
  public constructor(private readonly binary: string) {}
  public async resolve(_name: string): Promise<string> {
    return this.binary;
  }
}

function grabFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address !== null && typeof address === "object") {
        const port = address.port;
        server.close(() => resolve(port));
        return;
      }
      server.close();
      reject(new Error("could not grab a free port"));
    });
  });
}

describe("ChildProcessOpencodeSpawner diagnostics", () => {
  it("surfaces the opencode stderr and exit reason when the process exits before becoming healthy", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "concord-opencode-"));
    const fakeBin = path.join(dir, "opencode");
    writeFileSync(
      fakeBin,
      "#!/bin/sh\necho 'listen tcp 127.0.0.1: bind: address already in use' 1>&2\nexit 7\n",
    );
    chmodSync(fakeBin, 0o755);

    const port = await grabFreePort();
    const spawner = new ChildProcessOpencodeSpawner(new FixedBinaryResolver(fakeBin));

    await expect(spawner.spawn(dir, port)).rejects.toThrow(/address already in use/);
  });
});

describe("HealthProbeRecorder diagnostics", () => {
  // A clock the tests drive manually so the deadline-aware warning behaviour is
  // deterministic without real sleeps. Production passes Date.now.
  const timing = (warnAfterMs: number): { warnAfterMs: number; clock: () => number } => {
    let now = 0;
    return { warnAfterMs, clock: () => now };
  };

  it("summarizes observed http statuses, response bodies, connection errors, and probe count", () => {
    const recorder = new HealthProbeRecorder(41347, noopLogger, timing(10_000));
    recorder.record({ ok: false, error: "fetch failed: ECONNREFUSED" });
    recorder.record({ ok: false, status: 503, body: "warming up" });
    recorder.record({ ok: false, status: 503, body: "warming up" });

    const summary = recorder.summarize();

    expect(summary).toContain("port 41347");
    expect(summary).toContain("3 health probe(s)");
    expect(summary).toContain("http statuses observed: 503");
    expect(summary).toContain("last response body: warming up");
    expect(summary).toContain("last connection error: fetch failed: ECONNREFUSED");
  });

  it("stays silent during normal startup, then warns once readiness consumes most of the budget", () => {
    const logger = { log: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    // Drive the clock manually. warnAfterMs mirrors production: half of a 10s
    // budget. opencode registers its handler within ~1-2s; those probes must
    // not warn. Only past half the budget does readiness count as at risk.
    let now = 0;
    const clock = (): number => now;
    const recorder = new HealthProbeRecorder(9999, logger, { warnAfterMs: 5_000, clock });

    now = 1_000;
    recorder.record({ ok: false, status: 503, body: "warming up" });
    expect(logger.warn).not.toHaveBeenCalled();

    now = 2_500;
    recorder.record({ ok: false, status: 503, body: "warming up" });
    expect(logger.warn).not.toHaveBeenCalled();

    // Past half the budget: warn once, carrying elapsed time and probe count,
    // and do not repeat on later probes.
    now = 5_500;
    recorder.record({ ok: false, status: 503, body: "warming up" });
    recorder.record({ ok: false, error: "ECONNRESET" });

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][2]).toMatchObject({ port: 9999 });
    expect(logger.warn.mock.calls[0][2]).toMatchObject({ detail: expect.stringContaining("http 503") });
    expect(logger.warn.mock.calls[0][2]).toMatchObject({ probes: 3, elapsedMs: 5_500 });
  });

  it("does not warn when the server becomes healthy within the normal startup window", () => {
    const logger = { log: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const recorder = new HealthProbeRecorder(9999, logger, timing(5_000));
    // A couple of transient startup misses, then ready: this is the regression
    // scenario (single "connection error: fetch failed" at spawn time).
    recorder.record({ ok: false, error: "fetch failed" });
    recorder.record({ ok: true });

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("reports when no probes completed", () => {
    const recorder = new HealthProbeRecorder(1, noopLogger, timing(10_000));
    expect(recorder.summarize()).toContain("no health probes completed");
  });
});

describe("buildPromptBody", () => {
  const baseOptions = { agentId: "verifier", modelId: "zai-coding-plan/glm-5.2", runId: "r", consumerId: "c", maxInputRounds: 0 };

  it("wraps a structured schema as an opencode OutputFormat (type: json_schema), not a raw schema", () => {
    const schema = { type: "object", properties: { verdict: { type: "string" } } };
    const body = buildPromptBody("review", baseOptions, schema);
    expect(body.format).toEqual({ type: "json_schema", schema });
    // raw schema (which opencode rejects with 400 "Expected OutputFormat") must not leak through
    expect(body.format).not.toEqual(schema);
  });

  it("omits format entirely when no schema is requested", () => {
    const body = buildPromptBody("fix it", { ...baseOptions, modelId: "" }, undefined);
    expect(body.format).toBeUndefined();
    expect(body.model).toBeUndefined();
    expect(body.agent).toBe("verifier");
    expect(body.parts).toEqual([{ type: "text", text: "fix it" }]);
  });

  it("splits a provider/model id and passes it through", () => {
    const body = buildPromptBody("x", baseOptions);
    expect(body.model).toEqual({ providerID: "zai-coding-plan", modelID: "glm-5.2" });
  });
});

describe("extractStructuredOutput", () => {
  it("returns the input of the StructuredOutput tool call from message parts", () => {
    const parts = [
      { type: "step-start" },
      { type: "reasoning", text: "thinking" },
      { type: "tool", tool: "bash", state: { status: "completed" } },
      { type: "tool", tool: "StructuredOutput", state: { status: "completed", input: { verdict: "approved", summary: "ok" } } },
      { type: "step-finish" },
    ];
    expect(extractStructuredOutput(parts)).toEqual({ verdict: "approved", summary: "ok" });
  });

  it("returns the latest StructuredOutput input when several exist (retries)", () => {
    const parts = [
      { type: "tool", tool: "StructuredOutput", state: { status: "completed", input: { verdict: "approved", summary: "first" } } },
      { type: "tool", tool: "StructuredOutput", state: { status: "completed", input: { verdict: "changes_requested", summary: "second" } } },
    ];
    expect(extractStructuredOutput(parts)).toEqual({ verdict: "changes_requested", summary: "second" });
  });

  it("returns undefined when no StructuredOutput tool call is present", () => {
    expect(extractStructuredOutput([{ type: "text", text: "no verdict here" }])).toBeUndefined();
    expect(extractStructuredOutput(undefined)).toBeUndefined();
    expect(extractStructuredOutput([])).toBeUndefined();
  });
});

class CapturingBackend implements RunMcpBackend {
  public readonly tools: Map<string, { name: string; description: string; inputSchema: unknown; handler: (args: unknown) => Promise<unknown> }> = new Map();
  public started = false;
  public closed = false;

  public registerTool(
    name: string,
    description: string,
    inputSchema: unknown,
    handler: (args: unknown) => Promise<unknown>,
  ): void {
    this.tools.set(name, { name, description, inputSchema, handler });
  }

  public async start(): Promise<void> {
    this.started = true;
  }

  public async close(): Promise<void> {
    this.closed = true;
  }
}

class CapturingBackendFactory implements RunMcpBackendFactory {
  public readonly backend = new CapturingBackend();
  public requestedPorts: number[] = [];

  public async create(port: number): Promise<RunMcpBackend> {
    this.requestedPorts.push(port);
    return this.backend;
  }
}

class StubRequestRunInput implements RequestRunInput {
  public async request(_runId: string, _definition: unknown): Promise<Record<string, string | string[]>> {
    return {};
  }
}

class StubRecordRunUpdate implements RecordRunUpdate {
  public async record(runId: string, message: string): Promise<RunUpdate> {
    return new RunUpdate("update-1", runId, "c-1", message, new Date("2026-07-28T09:00:00Z"));
  }
}

function makeWiring(backendFactory: CapturingBackendFactory) {
  return {
    requestRunInput: new StubRequestRunInput(),
    recordRunUpdate: new StubRecordRunUpdate(),
    mcpBackendFactory: backendFactory,
  };
}

describe("OpencodeSdkRunner run-input MCP wiring", () => {
  it("always starts the tools MCP server before spawn and registers both tools under concord-run-tools", async () => {
    const handle = new RecordingHandle(44060);
    const spawner = new FakeSpawner(handle);
    const client = new FakePromptClient(undefined);
    const factory = new FakeClientFactory(client);
    const backendFactory = new CapturingBackendFactory();
    const runner = new OpencodeSdkRunner(spawner, factory, () => 44060, makeWiring(backendFactory));

    await runner.run("/wt", "x", {
      agentId: "scope",
      modelId: "zai-coding-plan/glm-5.2",
      runId: "run-1",
      consumerId: "c-1",
      maxInputRounds: 2,
    });

    expect(backendFactory.backend.started).toBe(true);
    expect(backendFactory.backend.closed).toBe(true);
    expect([...backendFactory.backend.tools.keys()].sort()).toEqual(["ask_question", "post_update"]);

    expect(spawner.spawns).toHaveLength(1);
    const env = spawner.spawns[0].env;
    expect(env).toBeDefined();
    const configContent = env!.OPENCODE_CONFIG_CONTENT;
    expect(configContent).toBeDefined();
    const config = JSON.parse(configContent);
    expect(config.permission).toBe("allow");
    expect(config.mcp["concord-run-tools"].type).toBe("remote");
    expect(config.mcp["concord-run-tools"].url).toBe(`http://127.0.0.1:${backendFactory.requestedPorts[0]}/mcp`);
    expect(config.mcp["concord-run-tools"].enabled).toBe(true);
    // The ask_question tool blocks for up to a full day waiting for a human.
    // The per-server timeout must be sized to that worst case (24h + buffer) so
    // opencode's ~60s default never aborts the call mid-wait.
    expect(config.mcp["concord-run-tools"].timeout).toBeGreaterThan(60 * 60 * 1000);
    expect(config.mcp["concord-input"]).toBeUndefined();
  });

  it("registers post_update but not ask_question when maxInputRounds is 0", async () => {
    const handle = new RecordingHandle(44061);
    const spawner = new FakeSpawner(handle);
    const client = new FakePromptClient(undefined);
    const factory = new FakeClientFactory(client);
    const backendFactory = new CapturingBackendFactory();
    const runner = new OpencodeSdkRunner(spawner, factory, () => 44061, makeWiring(backendFactory));

    await runner.run("/wt", "x", {
      agentId: "scope",
      modelId: "zai-coding-plan/glm-5.2",
      runId: "run-1",
      consumerId: "c-1",
      maxInputRounds: 0,
    });

    expect(backendFactory.backend.started).toBe(true);
    expect([...backendFactory.backend.tools.keys()]).toEqual(["post_update"]);

    const env = spawner.spawns[0].env;
    expect(env).toBeDefined();
    expect(env!.OPENCODE_CONFIG_CONTENT).toBeDefined();
  });

  it("does not start the MCP server when runInput wiring is null even if maxInputRounds is positive", async () => {
    const handle = new RecordingHandle(44062);
    const spawner = new FakeSpawner(handle);
    const client = new FakePromptClient(undefined);
    const factory = new FakeClientFactory(client);
    const runner = new OpencodeSdkRunner(spawner, factory, () => 44062);

    await runner.run("/wt", "x", {
      agentId: "scope",
      modelId: "zai-coding-plan/glm-5.2",
      runId: "run-1",
      consumerId: "c-1",
      maxInputRounds: 2,
    });

    const env = spawner.spawns[0].env;
    expect(env).toBeDefined();
    const config = JSON.parse(env!.OPENCODE_CONFIG_CONTENT);
    // No MCP server is registered without wiring, but permissions are still
    // pre-approved so the run is never gated on a permission prompt.
    expect(config.permission).toBe("allow");
    expect(config.mcp).toBeUndefined();
  });

  it("closes the MCP server when the opencode spawn fails", async () => {
    const spawner = new FlakySpawner(1000);
    const client = new FakePromptClient(undefined);
    const factory = new FakeClientFactory(client);
    const backendFactory = new CapturingBackendFactory();
    const runner = new OpencodeSdkRunner(spawner, factory, () => 44063, makeWiring(backendFactory));

    await expect(
      runner.run("/wt", "x", {
        agentId: "scope",
        modelId: "zai-coding-plan/glm-5.2",
        runId: "run-1",
        consumerId: "c-1",
        maxInputRounds: 2,
      }),
    ).rejects.toThrow("did not become healthy after 3 attempts");

    expect(backendFactory.backend.started).toBe(true);
    expect(backendFactory.backend.closed).toBe(true);
  });

  it("closes the MCP server when the signal is already aborted before start", async () => {
    const handle = new RecordingHandle(44064);
    const spawner = new FakeSpawner(handle);
    const client = new FakePromptClient(undefined);
    const factory = new FakeClientFactory(client);
    const backendFactory = new CapturingBackendFactory();
    const runner = new OpencodeSdkRunner(spawner, factory, () => 44064, makeWiring(backendFactory));

    const controller = new AbortController();
    controller.abort();

    await expect(
      runner.run("/wt", "x", {
        agentId: "scope",
        modelId: "zai-coding-plan/glm-5.2",
        runId: "run-1",
        consumerId: "c-1",
        maxInputRounds: 2,
      }, controller.signal),
    ).rejects.toThrow("aborted before start");

    expect(backendFactory.backend.started).toBe(true);
    expect(backendFactory.backend.closed).toBe(true);
    expect(handle.killed).toBe(true);
  });
});

describe("probeHealth", () => {
  it("does not hang when the server accepts the connection but never responds", async () => {
    // A blackhole TCP server: accepts the connection, never writes a response.
    // A bare fetch would hang here forever; the bounded probe must fail fast.
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("could not bind blackhole server");
    }
    const port = address.port;
    try {
      const start = Date.now();
      const outcome = await probeHealth(port);
      const elapsed = Date.now() - start;

      expect(outcome.ok).toBe(false);
      expect("error" in outcome && outcome.error.length > 0).toBe(true);
      expect(elapsed).toBeLessThan(5_000);
    } finally {
      server.close();
    }
  });
});

// A prompt client whose in-flight prompt either hangs until the attempt's
// AbortSignal fires (then rejects with the signal's reason — the observable
// behaviour of a real dead provider stream aborted by the stall watchdog) or
// resolves immediately with a scripted value.
class AbortAwarePromptClient implements OpencodePromptClient {
  public readonly calls: AbortSignal[] = [];
  public constructor(private readonly script: Array<{ hang: true } | { value: unknown }>) {}
  public async createSession(): Promise<string> {
    return "session-fake";
  }
  public async prompt(
    _sessionId: string,
    _prompt: string,
    _options: OpencodeRunnerOptions,
    _schema?: object,
    signal?: AbortSignal,
  ): Promise<unknown> {
    this.calls.push(signal as AbortSignal);
    const step = this.script[this.calls.length - 1];
    if (step !== undefined && !(step as { hang?: boolean }).hang) {
      return (step as { value: unknown }).value;
    }
    return new Promise<unknown>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }
  public async subscribeEvents(_directory: string): Promise<OpencodeEventSubscription> {
    return noOpEventSubscription();
  }
}

describe("OpencodeSdkRunner model-stall retry", () => {
  function stallRunnerOptions(): OpencodeRunnerOptions {
    return { agentId: "opencode", modelId: "zai-coding-plan/glm-5.2", runId: "r", consumerId: "c", maxInputRounds: 0 };
  }

  it("re-sends the prompt after a ModelStreamStalledError abort and succeeds once the provider recovers", async () => {
    vi.useFakeTimers();
    try {
      const handle = new RecordingHandle(44060);
      const spawner = new FakeSpawner(handle);
      const client = new AbortAwarePromptClient([{ hang: true }, { value: "ok" }]);
      const factory = new FakeClientFactory(client as unknown as FakePromptClient);
      // threshold 1s, tool stall 60s, cumulative budget 2s, 1 stall retry
      const runner = new OpencodeSdkRunner(spawner, factory as unknown as OpencodeClientFactory, () => 44060, undefined, noopLogger, undefined, 1_000, 60_000, 2_000, 1);

      const controller = new AbortController();
      const promise = runner.run("/wt", "x", stallRunnerOptions(), controller.signal);

      // First attempt hangs with no session events. At 1s the watchdog
      // heartbeats (cumulative 1s < 2s budget); at 2s the budget is reached
      // and the attempt aborts with ModelStreamStalledError.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(client.calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(client.calls).toHaveLength(1);

      // 15s stall-retry delay, then the re-sent prompt completes ("ok").
      await vi.advanceTimersByTimeAsync(15_000);
      await vi.advanceTimersByTimeAsync(0);
      expect(client.calls).toHaveLength(2);

      await expect(promise).resolves.toBeUndefined();
      expect(handle.killed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails terminally with ModelStreamStalledError once stall retries are exhausted", async () => {
    vi.useFakeTimers();
    try {
      const handle = new RecordingHandle(44061);
      const spawner = new FakeSpawner(handle);
      const client = new AbortAwarePromptClient([{ hang: true }]);
      const factory = new FakeClientFactory(client as unknown as FakePromptClient);
      // threshold 1s, budget 2s, ZERO stall retries -> first abort is terminal
      const runner = new OpencodeSdkRunner(spawner, factory as unknown as OpencodeClientFactory, () => 44061, undefined, noopLogger, undefined, 1_000, 60_000, 2_000, 0);

      const controller = new AbortController();
      const promise = runner.run("/wt", "x", stallRunnerOptions(), controller.signal);

      // Attach the rejection handler before advancing timers so the abort's
      // rejection is never unhandled at a microtask checkpoint (repo convention).
      const expectation = expect(promise).rejects.toThrow(/opencode model stream appeared stalled/);
      await vi.advanceTimersByTimeAsync(2_000);
      await expectation;
      expect(client.calls).toHaveLength(1);
      expect(handle.killed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
