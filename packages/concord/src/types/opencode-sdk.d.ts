// Loose shim for the @opencode-ai/sdk package. The SDK ships ESM-only types via
// conditional package exports that the consuming package's CommonJS TypeScript
// resolution cannot follow. We declare only the surface used by the runner;
// the runtime resolves the real module through Node's CJS/ESM interop.
declare module "@opencode-ai/sdk" {
  export interface OpencodeClient {
    session: {
      create(options?: { body?: unknown }): Promise<{ data: { id: string } }>;
      prompt(options: {
        path: { id: string };
        body: {
          agent?: string;
          parts: Array<{ type: "text"; text: string }>;
          model?: { providerID: string; modelID: string };
          format?: object;
        };
        signal?: AbortSignal;
      }): Promise<{ data: unknown }>;
    };
  }
  export function createOpencodeClient(config?: { baseUrl?: string; directory?: string }): OpencodeClient;
}
