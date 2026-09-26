import { describe, it, expect } from "vitest";
import { createServer } from "net";

import { RealRunMcpBackendFactory, type SdkBundle } from "../src/infra/adapters/opencode/real-run-input-mcp-backend";
import type { AskQuestionToolResult } from "../src/infra/adapters/opencode/run-input-mcp-server";

// Regression guard for the generalized multi-tool MCP backend.
//
// The backend previously registered the ask_question tool through the
// high-level McpServer.registerTool, which requires a Zod (raw) shape and
// rejects the plain JSON Schema with "inputSchema must be a Zod schema or raw
// shape, received an unrecognized object". That throw happened on every request
// (initialize included), so the backend answered HTTP 500 to everything and the
// agent could never discover the ask_question tool — making spec-scope runs
// silently non-interactive. These tests drive the REAL backend over HTTP with
// the actual MCP JSON-RPC handshake so any such registration failure surfaces
// as a failing assertion instead of a silent 500.

const HOST = "127.0.0.1";

// Resolve the SDK the way vitest can (plain await import). The backend's own
// loadSdk() uses a new Function("return import()") shim for the CJS build, which
// vitest cannot run, so inject this resolved bundle through the factory's DI seam.
// This still drives the REAL HttpMcpBackend over HTTP with the real SDK classes.
async function loadSdkForTest(): Promise<SdkBundle> {
  const server = (await import("@modelcontextprotocol/sdk/server/index.js")) as { Server: SdkBundle["Server"] };
  const transport = (await import("@modelcontextprotocol/sdk/server/streamableHttp.js")) as {
    StreamableHTTPServerTransport: SdkBundle["StreamableHTTPServerTransport"];
  };
  const types = (await import("@modelcontextprotocol/sdk/types.js")) as {
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

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, HOST, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("could not allocate a port"));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

// The StreamableHTTPServerTransport answers with an SSE stream whose single
// `data:` line carries the JSON-RPC response. Parse it back into an object.
async function rpc(port: number, method: string, params: unknown): Promise<{ status: number; result: unknown; error: unknown }> {
  const response = await fetch(`http://${HOST}:${port}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await response.text();
  const dataLine = text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .join("");
  const parsed = dataLine.length > 0 ? JSON.parse(dataLine) : JSON.parse(text);
  return { status: response.status, result: parsed.result, error: parsed.error };
}

describe("RealRunMcpBackend MCP handshake", () => {
  it("serves the ask_question tool over initialize/tools-list/tools-call without error", async () => {
    const port = await freePort();
    const factory = new RealRunMcpBackendFactory(await loadSdkForTest());
    const backend = await factory.create(port);

    const handlerCalls: unknown[] = [];
    const answer: AskQuestionToolResult = {
      content: [{ type: "text", text: JSON.stringify({ plan: "A" }) }],
      isError: false,
    };
    backend.registerTool(
      "ask_question",
      "Ask the user a question.",
      { type: "object", required: ["prompt", "fields"] },
      async (args) => {
        handlerCalls.push(args);
        return answer;
      },
    );

    await backend.start();
    try {
      const init = await rpc(port, "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "concord-test", version: "1" },
      });
      expect(init.status).toBe(200);
      expect(init.error).toBeUndefined();
      expect((init.result as { capabilities: { tools: unknown } }).capabilities.tools).toBeDefined();

      const list = await rpc(port, "tools/list", {});
      expect(list.status).toBe(200);
      expect(list.error).toBeUndefined();
      const tools = (list.result as { tools: Array<{ name: string; inputSchema: unknown }> }).tools;
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe("ask_question");
      expect(tools[0].inputSchema).toBeDefined();

      const call = await rpc(port, "tools/call", {
        name: "ask_question",
        arguments: { prompt: "Which?", fields: [{ key: "plan", label: "Plan", inputType: "text", defaultValue: "" }] },
      });
      expect(call.status).toBe(200);
      expect(call.error).toBeUndefined();
      expect(call.result).toEqual(answer);
      expect(handlerCalls).toHaveLength(1);
    } finally {
      await backend.close();
    }
  });

  it("lists and dispatches every registered tool when multiple are registered", async () => {
    const port = await freePort();
    const factory = new RealRunMcpBackendFactory(await loadSdkForTest());
    const backend = await factory.create(port);

    const calls: string[] = [];
    backend.registerTool(
      "ask_question",
      "Ask the user a question.",
      { type: "object", required: ["prompt"] },
      async () => {
        calls.push("ask_question");
        return { content: [{ type: "text", text: "asked" }], isError: false };
      },
    );
    backend.registerTool(
      "post_update",
      "Post a status update.",
      { type: "object", required: ["message"] },
      async () => {
        calls.push("post_update");
        return { content: [{ type: "text", text: "Update posted." }], isError: false };
      },
    );

    await backend.start();
    try {
      const list = await rpc(port, "tools/list", {});
      const tools = (list.result as { tools: Array<{ name: string }> }).tools;
      expect(tools.map((t) => t.name).sort()).toEqual(["ask_question", "post_update"]);

      const ask = await rpc(port, "tools/call", { name: "ask_question", arguments: { prompt: "x" } });
      expect(ask.error).toBeUndefined();

      const update = await rpc(port, "tools/call", { name: "post_update", arguments: { message: "hi" } });
      expect(update.error).toBeUndefined();
      expect((update.result as { content: { text: string }[] }).content[0].text).toBe("Update posted.");

      expect(calls).toEqual(["ask_question", "post_update"]);
    } finally {
      await backend.close();
    }
  });

  it("returns a tool error for an unknown tool name", async () => {
    const port = await freePort();
    const factory = new RealRunMcpBackendFactory(await loadSdkForTest());
    const backend = await factory.create(port);
    backend.registerTool(
      "ask_question",
      "Ask the user a question.",
      { type: "object" },
      async () => ({ content: [{ type: "text", text: "never" }], isError: false }),
    );
    await backend.start();
    try {
      const call = await rpc(port, "tools/call", { name: "not_a_tool", arguments: {} });
      expect(call.status).toBe(200);
      expect(call.error).toBeDefined();
    } finally {
      await backend.close();
    }
  });
});
