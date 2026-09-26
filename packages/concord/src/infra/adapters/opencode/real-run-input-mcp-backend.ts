import http from "node:http";
import type { AskQuestionToolResult, RunMcpBackend, RunMcpBackendFactory } from "./run-input-mcp-server";
import { RUN_TOOLS_MCP_SERVER_NAME } from "./run-input-mcp-server";

const HOST = "127.0.0.1";
const PATH = "/mcp";

interface RegisteredTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
  readonly handler: (args: unknown) => Promise<AskQuestionToolResult>;
}

// A generalized multi-tool MCP backend. The previous single-tool backend
// hard-coded ask_question; post_update needs to share the same per-run MCP
// lifecycle (one port, one process, one OPENCODE_CONFIG_CONTENT entry), so the
// backend now registers any number of tools and serves them all through the
// low-level ListTools/CallTool handlers.
class HttpMcpBackend implements RunMcpBackend {
  private server: http.Server | null = null;
  private connectedServers: ReadonlyArray<{ close(): Promise<void> }> = [];
  private readonly tools: Map<string, RegisteredTool> = new Map();

  public constructor(
    private readonly sdk: SdkBundle,
    private readonly port: number,
  ) {}

  public registerTool(
    name: string,
    description: string,
    inputSchema: unknown,
    handler: (args: unknown) => Promise<AskQuestionToolResult>,
  ): void {
    this.tools.set(name, { name, description, inputSchema, handler });
  }

  public async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch((cause) => {
        const message = cause instanceof Error ? cause.message : String(cause);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: message }));
        }
      });
    });
    await new Promise<void>((resolve) => {
      this.server!.listen(this.port, HOST, () => resolve());
    });
  }

  public async close(): Promise<void> {
    for (const srv of this.connectedServers) {
      try {
        await srv.close();
      } catch {
        // best-effort teardown
      }
    }
    this.connectedServers = [];
    const server = this.server;
    this.server = null;
    if (server !== null) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${HOST}`);
    if (url.pathname !== PATH) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `unknown path ${url.pathname}` }));
      return;
    }
    const body = req.method === "POST" ? await readBody(req) : undefined;
    const parsed = body === undefined ? undefined : safeParse(body);

    const transport = new this.sdk.StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const mcpServer = new this.sdk.Server(
      { name: RUN_TOOLS_MCP_SERVER_NAME, version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    mcpServer.setRequestHandler(this.sdk.ListToolsRequestSchema, async () => ({
      tools: [...this.tools.values()].map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    }));
    mcpServer.setRequestHandler(this.sdk.CallToolRequestSchema, async (request: unknown) => {
      const params = (request as { params: { name: string; arguments: unknown } }).params;
      const tool = this.tools.get(params.name);
      if (tool === undefined) {
        throw new Error(`Unknown tool: ${params.name}`);
      }
      return tool.handler(params.arguments);
    });
    await mcpServer.connect(transport);
    this.connectedServers = [...this.connectedServers, mcpServer];
    await transport.handleRequest(req as never, res as never, parsed);
  }
}

export interface SdkBundle {
  readonly Server: { new (...args: any[]): ServerLike };
  readonly StreamableHTTPServerTransport: { new (options: unknown): StreamableHttpTransportLike };
  readonly ListToolsRequestSchema: unknown;
  readonly CallToolRequestSchema: unknown;
}

// The low-level MCP Server (not the high-level McpServer). The high-level
// McpServer.registerTool requires the input schema as a Zod (raw) shape and
// rejects plain JSON Schemas with "inputSchema must be a Zod schema or raw
// shape", which silently broke tool registration for the ask_question tool
// (every request returned HTTP 500, so the agent never discovered the tool).
// The low-level Server exposes tools via JSON Schemas — MCP's native wire
// format. Argument validation is performed separately by each tool's handler.
interface ServerLike {
  setRequestHandler(schema: unknown, handler: (request: unknown, extra: unknown) => unknown): void;
  connect(transport: unknown): Promise<void>;
  close(): Promise<void>;
}

interface StreamableHttpTransportLike {
  handleRequest(req: unknown, res: unknown, parsedBody?: unknown): Promise<void>;
  close(): Promise<void>;
}

const importSdk = new Function(
  "specifier",
  "return import(specifier)",
) as (specifier: string) => Promise<Record<string, unknown>>;

async function loadSdk(): Promise<SdkBundle> {
  // The SDK's "/server" barrel exports only Server; StreamableHTTPServerTransport
  // lives on its own subpath. The original code read both off the barrel, which
  // resolved StreamableHTTPServerTransport (and McpServer) to undefined and made
  // every request throw "undefined is not a constructor" before tool registration
  // was even reached. Import each symbol from the subpath that actually exports it.
  const server = (await importSdk("@modelcontextprotocol/sdk/server")) as {
    Server: SdkBundle["Server"];
  };
  const transport = (await importSdk("@modelcontextprotocol/sdk/server/streamableHttp.js")) as {
    StreamableHTTPServerTransport: SdkBundle["StreamableHTTPServerTransport"];
  };
  const types = (await importSdk("@modelcontextprotocol/sdk/types.js")) as {
    ListToolsRequestSchema: SdkBundle["ListToolsRequestSchema"];
    CallToolRequestSchema: SdkBundle["CallToolRequestSchema"];
  };
  return {
    Server: server.Server,
    StreamableHTTPServerTransport: transport.StreamableHTTPServerTransport,
    ListToolsRequestSchema: types.ListToolsRequestSchema,
    CallToolRequestSchema: types.CallToolRequestSchema,
  };
}

export class RealRunMcpBackendFactory implements RunMcpBackendFactory {
  private sdkPromise: Promise<SdkBundle> | null = null;

  // Optional pre-resolved SDK bundle for tests. Production leaves this unset so
  // the bundle is loaded lazily via loadSdk() (the new Function import shim the
  // CJS build needs). vitest cannot run that shim, so tests inject a bundle
  // resolved with plain await import() and still exercise the real backend.
  public constructor(private readonly sdk?: SdkBundle) {}

  public async create(port: number): Promise<RunMcpBackend> {
    if (this.sdk !== undefined) {
      return new HttpMcpBackend(this.sdk, port);
    }
    if (this.sdkPromise === null) {
      this.sdkPromise = loadSdk();
    }
    const resolved = await this.sdkPromise;
    return new HttpMcpBackend(resolved, port);
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
