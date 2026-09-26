import type { RecordRunUpdate } from "../../../domain/ports/in/record-run-update";
import type { RunActivityEmitter } from "./run-activity-emitter";
import type { PortAllocator } from "./opencode-sdk-runner";
import type {
  AskQuestionToolResult,
  RunMcpBackend,
  RunMcpBackendFactory,
} from "./run-input-mcp-server";

const HOST = "127.0.0.1";

// The tool name as the model sees it. The model calls post_update at meaningful
// checkpoints to post a one-way markdown status update; it must NOT be used to
// ask questions or wait for a response (ask_question exists for that).
export const POST_UPDATE_TOOL_NAME = "post_update";

const POST_UPDATE_DESCRIPTION =
  "Post a concise markdown status update to keep the operator informed of progress, decisions, and results. " +
  "This is fire-and-forget: it returns immediately, does not wait for a response, and MUST NOT be used to ask questions " +
  "(use ask_question when you need input).\n\n" +
  "Call this tool at exactly these checkpoints — and only these — so the operator can follow the run without watching every step:\n" +
  "- ONCE when you have a solid understanding of the task and a plan: briefly state what you will do.\n" +
  "- Whenever there is a PIVOT: a change in direction, a significant design decision, or a new finding that alters the plan.\n" +
  "- When the work is COMPLETE: post a short summary of what was done, and include any relevant links (for example, the URL of a spec or issue you just created).\n\n" +
  "Guidance:\n" +
  "- Keep each update concise and factual; do not post every step or duplicate the same status.\n" +
  "- When you mention a URL (a spec, an issue, a PR), write it as a full bare URL on its own (e.g. https://github.com/owner/repo/issues/1) so it renders as a clickable link. Do not wrap URLs in backticks.\n" +
  "- Never use this tool to ask a question or to wait for input.";

export const POST_UPDATE_SCHEMA = {
  type: "object",
  properties: {
    message: {
      type: "string",
      description: "The markdown status update to post. Non-empty, capped at 8 KiB.",
    },
  },
  required: ["message"],
};

export interface RunUpdateMcpServerOptions {
  readonly runId: string;
  readonly consumerId: string;
  readonly sessionId: string;
  readonly portAllocator: PortAllocator;
  readonly backendFactory: RunMcpBackendFactory;
}

export interface StartedRunUpdateMcpServer {
  readonly endpoint: string;
  close(): Promise<void>;
}

export class RunUpdateMcpServer {
  public constructor(
    private readonly recordRunUpdate: RecordRunUpdate,
    private readonly runActivityEmitter: RunActivityEmitter,
    private readonly runId: string,
    private readonly consumerId: string,
    private readonly sessionId: string,
    private readonly portAllocator: PortAllocator,
    private readonly backendFactory: RunMcpBackendFactory,
  ) {}

  public static boundTo(
    recordRunUpdate: RecordRunUpdate,
    emitter: RunActivityEmitter,
    options: RunUpdateMcpServerOptions,
  ): RunUpdateMcpServer {
    return new RunUpdateMcpServer(
      recordRunUpdate,
      emitter,
      options.runId,
      options.consumerId,
      options.sessionId,
      options.portAllocator,
      options.backendFactory,
    );
  }

  public async handleToolCall(args: unknown): Promise<AskQuestionToolResult> {
    const message = parseMessage(args);
    if (message === null) {
      return errorResult("post_update requires a non-empty 'message' string");
    }
    try {
      const update = await this.recordRunUpdate.record(this.runId, message);
      this.runActivityEmitter.emit({
        runId: this.runId,
        consumerId: this.consumerId,
        sessionId: this.sessionId,
        kind: "run.update",
        payload: { message: update.message, updateId: update.id },
        at: update.createdAt.toISOString(),
      });
      return { content: [{ type: "text", text: "Update posted." }], isError: false };
    } catch (cause) {
      return errorResult(describe(cause));
    }
  }

  // Registers post_update on a shared backend so it sits beside ask_question on
  // the single per-run MCP server (one port, one OPENCODE_CONFIG_CONTENT entry).
  public registerTools(backend: RunMcpBackend): void {
    backend.registerTool(POST_UPDATE_TOOL_NAME, POST_UPDATE_DESCRIPTION, POST_UPDATE_SCHEMA, (args) =>
      this.handleToolCall(args),
    );
  }

  public async start(): Promise<StartedRunUpdateMcpServer> {
    const port = await this.portAllocator();
    const backend = await this.backendFactory.create(port);
    this.registerTools(backend);
    await backend.start();
    return {
      endpoint: `http://${HOST}:${port}/mcp`,
      close: () => backend.close(),
    };
  }
}

function parseMessage(args: unknown): string | null {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return null;
  }
  const message = (args as { message?: unknown }).message;
  if (typeof message !== "string" || message.length === 0) {
    return null;
  }
  return message;
}

function errorResult(message: string): AskQuestionToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

function describe(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.message;
  }
  return String(cause);
}
