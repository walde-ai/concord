import { describe, it, expect } from "vitest";

import {
  RunInputMcpServer,
  ASK_QUESTION_SCHEMA,
  type RunMcpBackend,
  type RunMcpBackendFactory,
} from "../src/infra/adapters/opencode/run-input-mcp-server";
import type { RequestRunInput } from "../src/domain/ports/in/request-run-input";
import { InputRoundsExceededError } from "../src/domain/exceptions/errors";

interface RegisteredTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
  readonly handler: (args: unknown) => Promise<unknown>;
}

class CapturingBackend implements RunMcpBackend {
  public readonly tools: Map<string, RegisteredTool> = new Map();
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

class CapturingFactory implements RunMcpBackendFactory {
  public readonly backend = new CapturingBackend();
  public requestedPorts: number[] = [];

  public async create(port: number): Promise<RunMcpBackend> {
    this.requestedPorts.push(port);
    return this.backend;
  }
}

class RecordingRequestRunInput implements RequestRunInput {
  public readonly calls: Array<{ runId: string; definition: unknown }> = [];
  public constructor(private readonly answers: Record<string, string | string[]>) {}

  public async request(runId: string, definition: unknown): Promise<Record<string, string | string[]>> {
    this.calls.push({ runId, definition });
    return this.answers;
  }
}

class ThrowingRequestRunInput implements RequestRunInput {
  public constructor(private readonly error: unknown) {}
  public async request(_runId: string, _definition: unknown): Promise<Record<string, string | string[]>> {
    throw this.error;
  }
}

describe("RunInputMcpServer", () => {
  it("registers the ask_question handler with the backend on start and tears it down on close", async () => {
    const factory = new CapturingFactory();
    const server = new RunInputMcpServer(
      new RecordingRequestRunInput({ plan: "A" }),
      "run-1",
      "c-1",
      () => 5000,
      factory,
    );

    const started = await server.start();
    expect(factory.requestedPorts).toEqual([5000]);
    expect(factory.backend.started).toBe(true);
    expect(factory.backend.tools.has("ask_question")).toBe(true);
    expect(factory.backend.tools.get("ask_question")?.inputSchema).toBeDefined();
    expect(started.endpoint).toBe("http://127.0.0.1:5000/mcp");

    await started.close();
    expect(factory.backend.closed).toBe(true);
  });

  it("handleToolCall parses args, calls RequestRunInput, and returns the answers as JSON text", async () => {
    const requestRunInput = new RecordingRequestRunInput({ plan: "B", note: "ok" });
    const server = new RunInputMcpServer(
      requestRunInput,
      "run-1",
      "c-1",
      () => 5001,
      new CapturingFactory(),
    );

    const result = await server.handleToolCall({
      prompt: "Which plan?",
      fields: [
        { key: "plan", label: "Plan", inputType: "select", options: ["A", "B"], allowOther: false, defaultValue: "A" },
        { key: "note", label: "Note", inputType: "text", defaultValue: "" },
      ],
    });

    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0].text)).toEqual({ plan: "B", note: "ok" });
    expect(requestRunInput.calls).toHaveLength(1);
    expect(requestRunInput.calls[0].runId).toBe("run-1");
  });

  it("handleToolCall forwards an optional Markdown context onto the form definition", async () => {
    const requestRunInput = new RecordingRequestRunInput({ plan: "A" });
    const server = new RunInputMcpServer(
      requestRunInput,
      "run-1",
      "c-1",
      () => 5006,
      new CapturingFactory(),
    );

    const result = await server.handleToolCall({
      prompt: "Which plan?",
      context: "## Findings\nThe read path leaks an S3 URL.",
      fields: [
        { key: "plan", label: "Plan", inputType: "select", options: ["A", "B"], defaultValue: "A" },
      ],
    });

    expect(result.isError).toBe(false);
    expect(requestRunInput.calls).toHaveLength(1);
    expect((requestRunInput.calls[0].definition as { context?: string }).context).toBe(
      "## Findings\nThe read path leaks an S3 URL.",
    );
  });

  it("exposes context as an optional property in the ask_question input schema", () => {
    const props = ASK_QUESTION_SCHEMA.properties as { context?: { type: string } };
    expect(props.context?.type).toBe("string");
    expect((ASK_QUESTION_SCHEMA.required as readonly string[])).not.toContain("context");
  });

  it("handleToolCall surfaces InputRoundsExceededError as an instruction to proceed without asking", async () => {
    const server = new RunInputMcpServer(
      new ThrowingRequestRunInput(new InputRoundsExceededError("run-1", 1)),
      "run-1",
      "c-1",
      () => 5002,
      new CapturingFactory(),
    );

    const result = await server.handleToolCall({
      prompt: "Which?",
      fields: [{ key: "note", label: "Note", inputType: "text", defaultValue: "" }],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("limit reached");
  });

  it("handleToolCall returns a tool error for malformed arguments", async () => {
    const server = new RunInputMcpServer(
      new RecordingRequestRunInput({}),
      "run-1",
      "c-1",
      () => 5003,
      new CapturingFactory(),
    );

    const noFields = await server.handleToolCall({ prompt: "x", fields: [] });
    expect(noFields.isError).toBe(true);

    const badInputType = await server.handleToolCall({
      prompt: "x",
      fields: [{ key: "a", label: "A", inputType: "colour", defaultValue: "" }],
    });
    expect(badInputType.isError).toBe(true);
  });

  it("handleToolCall defaults an omitted allowOther to false for select and checkbox fields", async () => {
    // The ask_question JSON schema lists allowOther as optional, so the model
    // may omit it. The parser must accept that (defaulting to false) rather than
    // rejecting the call, which previously forced a wasteful retry of the whole
    // question. The resolved definition should carry allowOther: false.
    const requestRunInput = new RecordingRequestRunInput({ plan: "A", tags: "x" });
    const server = new RunInputMcpServer(
      requestRunInput,
      "run-1",
      "c-1",
      () => 5004,
      new CapturingFactory(),
    );

    const result = await server.handleToolCall({
      prompt: "Pick?",
      fields: [
        { key: "plan", label: "Plan", inputType: "select", options: ["A", "B"], defaultValue: "A" },
        { key: "tags", label: "Tags", inputType: "checkbox", options: ["x", "y"], defaultValue: ["x"] },
      ],
    });

    expect(result.isError).toBe(false);
    expect(requestRunInput.calls).toHaveLength(1);
    const fields = (requestRunInput.calls[0].definition as { fields: Array<{ allowOther: unknown }> }).fields;
    expect(fields[0].allowOther).toBe(false);
    expect(fields[1].allowOther).toBe(false);
  });

  it("handleToolCall still rejects a non-boolean allowOther", async () => {
    const server = new RunInputMcpServer(
      new RecordingRequestRunInput({}),
      "run-1",
      "c-1",
      () => 5005,
      new CapturingFactory(),
    );

    const result = await server.handleToolCall({
      prompt: "Pick?",
      fields: [{ key: "plan", label: "Plan", inputType: "select", options: ["A"], defaultValue: "A", allowOther: "yes" }],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("allowOther must be a boolean");
  });
});
