import { describe, it, expect } from "vitest";

import {
  RunUpdateMcpServer,
  POST_UPDATE_TOOL_NAME,
  type StartedRunUpdateMcpServer,
} from "../src/infra/adapters/opencode/run-update-mcp-server";
import type {
  RunMcpBackend,
  RunMcpBackendFactory,
  AskQuestionToolResult,
} from "../src/infra/adapters/opencode/run-input-mcp-server";
import type { RecordRunUpdate } from "../src/domain/ports/in/record-run-update";
import { RunUpdate } from "../src/domain/entities/run-update";
import type { RunActivityEmitter, RunActivityFrame } from "../src/infra/adapters/opencode/run-activity-emitter";
import { InvalidRunUpdateMessageError } from "../src/domain/interactors/record-run-update-interactor";
import { MAX_RUN_UPDATE_MESSAGE_BYTES } from "../src/domain/interactors/record-run-update-interactor";

interface RegisteredTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
  readonly handler: (args: unknown) => Promise<AskQuestionToolResult>;
}

class CapturingBackend implements RunMcpBackend {
  public readonly tools: Map<string, RegisteredTool> = new Map();
  public started = false;
  public closed = false;

  public registerTool(
    name: string,
    description: string,
    inputSchema: unknown,
    handler: (args: unknown) => Promise<AskQuestionToolResult>,
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

class CapturingFactory implements RunMcpBackendFactory {
  public readonly backend = new CapturingBackend();
  public requestedPorts: number[] = [];

  public async create(port: number): Promise<RunMcpBackend> {
    this.requestedPorts.push(port);
    return this.backend;
  }
}

class RecordingRecordRunUpdate implements RecordRunUpdate {
  public readonly calls: Array<{ runId: string; message: string }> = [];
  public constructor(private readonly updates: RunUpdate[]) {}

  public async record(runId: string, message: string): Promise<RunUpdate> {
    this.calls.push({ runId, message });
    const next = this.updates.shift();
    if (next === undefined) {
      throw new Error("no programmed update");
    }
    return next;
  }
}

class ThrowingRecordRunUpdate implements RecordRunUpdate {
  public constructor(private readonly error: unknown) {}
  public async record(_runId: string, _message: string): Promise<RunUpdate> {
    throw this.error;
  }
}

class RecordingEmitter implements RunActivityEmitter {
  public readonly frames: RunActivityFrame[] = [];
  public emit(frame: RunActivityFrame): void {
    this.frames.push(frame);
  }
  public hasSubscribers(): boolean {
    return true;
  }
}

function makeUpdate(overrides: Partial<RunUpdate> = {}): RunUpdate {
  return new RunUpdate(
    overrides.id ?? "update-1",
    overrides.runId ?? "run-1",
    overrides.consumerId ?? "c-1",
    overrides.message ?? "Halfway done.",
    overrides.createdAt ?? new Date("2026-07-28T09:00:00Z"),
  );
}

describe("RunUpdateMcpServer", () => {
  it("registers the post_update tool on start and returns the started endpoint", async () => {
    const factory = new CapturingFactory();
    const server = new RunUpdateMcpServer(
      new RecordingRecordRunUpdate([makeUpdate()]),
      new RecordingEmitter(),
      "run-1",
      "c-1",
      "sess-1",
      () => 5100,
      factory,
    );

    const started: StartedRunUpdateMcpServer = await server.start();
    expect(factory.requestedPorts).toEqual([5100]);
    expect(factory.backend.started).toBe(true);
    expect(factory.backend.tools.has(POST_UPDATE_TOOL_NAME)).toBe(true);
    const tool = factory.backend.tools.get(POST_UPDATE_TOOL_NAME);
    expect(tool?.description).toContain("status update");
    expect((tool?.inputSchema as { required: string[] }).required).toEqual(["message"]);
    expect(started.endpoint).toBe("http://127.0.0.1:5100/mcp");

    await started.close();
    expect(factory.backend.closed).toBe(true);
  });

  it("parses message, calls RecordRunUpdate, emits a run.update frame, and acknowledges", async () => {
    const update = makeUpdate({ id: "update-9", message: "Compiling results." });
    const recordRunUpdate = new RecordingRecordRunUpdate([update]);
    const emitter = new RecordingEmitter();
    const factory = new CapturingFactory();
    const server = new RunUpdateMcpServer(recordRunUpdate, emitter, "run-1", "c-1", "sess-1", () => 5101, factory);
    await server.start();

    const handler = factory.backend.tools.get(POST_UPDATE_TOOL_NAME)!.handler;
    const result = await handler({ message: "Compiling results." });

    expect(result.isError).toBe(false);
    expect((result.content[0] as { text: string }).text).toBe("Update posted.");
    expect(recordRunUpdate.calls).toEqual([{ runId: "run-1", message: "Compiling results." }]);

    expect(emitter.frames).toHaveLength(1);
    const frame = emitter.frames[0];
    expect(frame.kind).toBe("run.update");
    expect(frame.runId).toBe("run-1");
    expect(frame.consumerId).toBe("c-1");
    expect(frame.sessionId).toBe("sess-1");
    expect(frame.payload).toEqual({ message: "Compiling results.", updateId: "update-9" });
    expect(new Date(frame.at).toISOString()).toBe(frame.at);
  });

  it("returns a tool error when message is missing or empty", async () => {
    const recordRunUpdate = new RecordingRecordRunUpdate([makeUpdate()]);
    const factory = new CapturingFactory();
    const server = new RunUpdateMcpServer(recordRunUpdate, new RecordingEmitter(), "run-1", "c-1", "sess-1", () => 5102, factory);
    await server.start();

    const handler = factory.backend.tools.get(POST_UPDATE_TOOL_NAME)!.handler;

    const missing = await handler({});
    expect(missing.isError).toBe(true);

    const empty = await handler({ message: "" });
    expect(empty.isError).toBe(true);

    const wrongType = await handler({ message: 42 });
    expect(wrongType.isError).toBe(true);

    expect(recordRunUpdate.calls).toHaveLength(0);
  });

  it("surfaces a validation failure from RecordRunUpdate as a tool error and emits no frame", async () => {
    const overlong = "x".repeat(MAX_RUN_UPDATE_MESSAGE_BYTES + 1);
    const recordRunUpdate = new ThrowingRecordRunUpdate(new InvalidRunUpdateMessageError("too long"));
    const emitter = new RecordingEmitter();
    const factory = new CapturingFactory();
    const server = new RunUpdateMcpServer(recordRunUpdate, emitter, "run-1", "c-1", "sess-1", () => 5103, factory);
    await server.start();

    const handler = factory.backend.tools.get(POST_UPDATE_TOOL_NAME)!.handler;
    const result = await handler({ message: overlong });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("too long");
    expect(emitter.frames).toHaveLength(0);
  });
});
