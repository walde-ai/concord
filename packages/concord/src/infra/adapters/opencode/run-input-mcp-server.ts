import type { RequestRunInput } from "../../../domain/ports/in/request-run-input";
import type { FormDefinition, FieldDefinition, AnswerMap } from "../../../domain/entities/run-form";
import { InputRoundsExceededError, InvalidFormAnswersError } from "../../../domain/exceptions/errors";
import type { PortAllocator } from "./opencode-sdk-runner";

const HOST = "127.0.0.1";
const TOOL_NAME = "ask_question";

// The per-run MCP server is renamed from concord-run-input to concord-run-tools
// because it now hosts more than the ask_question tool (post_update shares the
// same per-run lifecycle). One server name covers every tool registered on the
// shared backend, so a single OPENCODE_CONFIG_CONTENT entry exposes them all.
export const RUN_TOOLS_MCP_SERVER_NAME = "concord-run-tools";

const ASK_QUESTION_DESCRIPTION =
  "Ask the user a question with one or more fields. The call blocks until the user submits the form.\n\n" +
  "Guidelines:\n" +
  "- Provide `context`: a Markdown preamble presenting your analysis/findings so the user can answer in context. This is shown to the user BEFORE the prompt and fields. Keep it factual and concise.\n" +
  "- For every `select` field, set `defaultValue` to the option you recommend. The recommended option is the one the user most likely should pick; mark it by appending \" (Recommended)\" to its label AND set `defaultValue` to that exact option string. The UI pre-selects `defaultValue`, so this is what makes the recommendation the true default.\n" +
  "- A free-text \"Extra notes\" field is appended to the form automatically for every question; do NOT add your own catch-all notes field. You may still add focused text/textarea fields for specific inputs.\n" +
  "- Omit `allowOther` only when the choice set is truly closed; it defaults to false when omitted.";

export interface AskQuestionToolResult {
  readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>;
  readonly isError: boolean;
}

// A generalized multi-tool MCP backend. Tools are registered by name with their
// description, JSON-Schema input shape, and handler; the backend serves them all
// through its low-level ListTools/CallTool handlers. ask_question and post_update
// both register through this interface so they share one port and one process.
export interface RunMcpBackend {
  registerTool(
    name: string,
    description: string,
    inputSchema: unknown,
    handler: (args: unknown) => Promise<AskQuestionToolResult>,
  ): void;
  start(): Promise<void>;
  close(): Promise<void>;
}

export interface RunMcpBackendFactory {
  create(port: number): Promise<RunMcpBackend>;
}

// Backward-compatible aliases for callers that still reference the original
// single-tool names.
export type RunInputMcpBackend = RunMcpBackend;
export type RunInputMcpBackendFactory = RunMcpBackendFactory;

export interface RunInputMcpServerOptions {
  readonly runId: string;
  readonly consumerId: string;
  readonly portAllocator: PortAllocator;
  readonly backendFactory: RunMcpBackendFactory;
}

export interface StartedRunInputMcpServer {
  readonly endpoint: string;
  close(): Promise<void>;
}

export const ASK_QUESTION_SCHEMA = {
  type: "object",
  properties: {
    prompt: { type: "string", description: "The question to ask the user." },
    context: {
      type: "string",
      description:
        "Optional Markdown shown to the user BEFORE the prompt and fields. Use it to present your initial analysis/findings so the user can answer in context.",
    },
    fields: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        properties: {
          key: { type: "string" },
          label: { type: "string" },
          inputType: { type: "string", enum: ["checkbox", "select", "text", "textarea"] },
          options: { type: "array", items: { type: "string" } },
          allowOther: { type: "boolean" },
          defaultValue: {},
        },
        required: ["key", "label", "inputType", "defaultValue"],
      },
    },
  },
  required: ["prompt", "fields"],
};

export class RunInputMcpServer {
  public constructor(
    private readonly requestRunInput: RequestRunInput,
    private readonly runId: string,
    private readonly consumerId: string,
    private readonly portAllocator: PortAllocator,
    private readonly backendFactory: RunMcpBackendFactory,
  ) {}

  public static boundTo(
    requestRunInput: RequestRunInput,
    options: RunInputMcpServerOptions,
  ): RunInputMcpServer {
    return new RunInputMcpServer(
      requestRunInput,
      options.runId,
      options.consumerId,
      options.portAllocator,
      options.backendFactory,
    );
  }

  public async handleToolCall(args: unknown): Promise<AskQuestionToolResult> {
    let definition: FormDefinition;
    try {
      definition = parseToolArgs(args);
    } catch (cause) {
      return errorResult(describe(cause));
    }
    try {
      const answers = await this.requestRunInput.request(this.runId, definition);
      return okResult(answers);
    } catch (cause) {
      if (cause instanceof InputRoundsExceededError) {
        return errorResult(
          `No further questions are allowed for this run (limit reached). Proceed without asking.`,
        );
      }
      return errorResult(describe(cause));
    }
  }

  // Registers ask_question on a shared backend (one port hosts both ask_question
  // and post_update). Used by the runner so a single MCP server exposes every
  // per-run tool.
  public registerTools(backend: RunMcpBackend): void {
    backend.registerTool(TOOL_NAME, ASK_QUESTION_DESCRIPTION, ASK_QUESTION_SCHEMA, (args) =>
      this.handleToolCall(args),
    );
  }

  public async start(): Promise<StartedRunInputMcpServer> {
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

function okResult(answers: AnswerMap): AskQuestionToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(answers) }],
    isError: false,
  };
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

function parseToolArgs(args: unknown): FormDefinition {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    throw new InvalidFormAnswersError("ask_question arguments must be a JSON object");
  }
  const obj = args as { prompt?: unknown; fields?: unknown; context?: unknown };
  if (typeof obj.prompt !== "string" || obj.prompt.length === 0) {
    throw new InvalidFormAnswersError("ask_question requires a non-empty 'prompt' string");
  }
  if (obj.context !== undefined && typeof obj.context !== "string") {
    throw new InvalidFormAnswersError("ask_question 'context' must be a string when provided");
  }
  if (!Array.isArray(obj.fields) || obj.fields.length === 0) {
    throw new InvalidFormAnswersError("ask_question requires a non-empty 'fields' array");
  }
  const fields: FieldDefinition[] = obj.fields.map((raw, index) => parseField(raw, index));
  return {
    prompt: obj.prompt,
    fields,
    ...(typeof obj.context === "string" && obj.context.length > 0 ? { context: obj.context } : {}),
  };
}

function parseField(raw: unknown, index: number): FieldDefinition {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new InvalidFormAnswersError(`Field at index ${index} must be a JSON object`);
  }
  const obj = raw as {
    key?: unknown;
    label?: unknown;
    inputType?: unknown;
    options?: unknown;
    allowOther?: unknown;
    defaultValue?: unknown;
  };
  if (typeof obj.key !== "string" || obj.key.length === 0) {
    throw new InvalidFormAnswersError(`Field at index ${index} requires a non-empty 'key' string`);
  }
  if (typeof obj.label !== "string") {
    throw new InvalidFormAnswersError(`Field ${obj.key} requires a 'label' string`);
  }
  if (
    obj.inputType !== "checkbox" &&
    obj.inputType !== "select" &&
    obj.inputType !== "text" &&
    obj.inputType !== "textarea"
  ) {
    throw new InvalidFormAnswersError(
      `Field ${obj.key} inputType must be one of checkbox, select, text, textarea`,
    );
  }
  if (obj.inputType === "text" || obj.inputType === "textarea") {
    if (typeof obj.defaultValue !== "string") {
      throw new InvalidFormAnswersError(`Field ${obj.key} defaultValue must be a string`);
    }
    return {
      key: obj.key,
      label: obj.label,
      inputType: obj.inputType,
      defaultValue: obj.defaultValue,
    };
  }
  if (!Array.isArray(obj.options) || obj.options.some((v) => typeof v !== "string") || obj.options.length === 0) {
    throw new InvalidFormAnswersError(`Field ${obj.key} options must be a non-empty string array`);
  }
  // The tool's JSON schema lists allowOther as OPTIONAL, so the model may omit
  // it. Treat an omitted allowOther as false rather than rejecting the call —
  // rejecting forced the agent to retry the whole question, wasting a round and
  // (before the MCP-timeout fix) racing the input-wait clock. A non-boolean
  // value is still rejected as malformed.
  if (obj.allowOther !== undefined && typeof obj.allowOther !== "boolean") {
    throw new InvalidFormAnswersError(`Field ${obj.key} allowOther must be a boolean`);
  }
  const allowOther = obj.allowOther ?? false;
  if (obj.inputType === "checkbox") {
    if (!Array.isArray(obj.defaultValue) || obj.defaultValue.some((v) => typeof v !== "string")) {
      throw new InvalidFormAnswersError(`Field ${obj.key} defaultValue must be a string array`);
    }
    return {
      key: obj.key,
      label: obj.label,
      inputType: "checkbox",
      options: [...obj.options],
      allowOther,
      defaultValue: [...obj.defaultValue],
    };
  }
  if (typeof obj.defaultValue !== "string") {
    throw new InvalidFormAnswersError(`Field ${obj.key} defaultValue must be a string`);
  }
  return {
    key: obj.key,
    label: obj.label,
    inputType: "select",
    options: [...obj.options],
    allowOther,
    defaultValue: obj.defaultValue,
  };
}

export { TOOL_NAME };
