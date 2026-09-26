import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ApiClient, ApiClientError } from "./api-client";
import {
  setSession,
  setRefreshHandler,
  setInvalidHandler,
} from "./session-holder";

function jsonResponse(body: unknown, status = 200): { status: number; json: () => Promise<unknown> } {
  return { status, json: () => Promise.resolve(body) };
}

describe("ApiClient — unauthenticated (no signing headers)", () => {
  beforeEach(() => {
    setSession(null);
    vi.restoreAllMocks();
  });

  it("unwraps a success envelope and returns the data", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          ok: true,
          data: { items: [{ id: "evt-1", type: "foo" }], total: 1, limit: 50, offset: 0 },
        }),
      ),
    );

    const client = new ApiClient();
    const result = await client.listEvents();

    expect(result.items).toHaveLength(1);
    expect(result.total).toBe(1);
  });

  it("throws an ApiClientError on a failure envelope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({ ok: false, error: { code: "NOT_FOUND", message: "Event not found" } }),
      ),
    );

    const client = new ApiClient();

    await expect(client.getEvent("missing")).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Event not found",
    });
    await expect(client.getEvent("missing")).rejects.toBeInstanceOf(ApiClientError);
  });
});

describe("ApiClient — request shape", () => {
  beforeEach(() => {
    setSession(null);
    vi.restoreAllMocks();
  });

  it("lists producers via GET without a body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        data: [
          { id: "p-1", enabled: true, disableable: true },
          { id: "p-2", enabled: false, disableable: true },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new ApiClient();
    const result = await client.listProducers();

    expect(fetchMock).toHaveBeenCalledWith("/api/producers", expect.objectContaining({ method: "GET" }));
    expect(result).toHaveLength(2);
  });

  it("patches a producer with a JSON body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ ok: true, data: { id: "p-1", enabled: false, disableable: true } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new ApiClient();
    const result = await client.setProducerEnabled("p-1", false);

    const [, init] = fetchMock.mock.calls[0];
    expect(init).toMatchObject({
      method: "PATCH",
      body: JSON.stringify({ enabled: false }),
    });
    expect((init as RequestInit).headers).toMatchObject({ "Content-Type": "application/json" });
    expect(result).toEqual({ id: "p-1", enabled: false, disableable: true });
  });

  it("throws an ApiClientError when a PATCH returns a failure envelope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({ ok: false, error: { code: "NOT_FOUND", message: "Producer not found" } }),
      ),
    );

    const client = new ApiClient();
    await expect(client.setProducerEnabled("ghost", false)).rejects.toBeInstanceOf(ApiClientError);
    await expect(client.setConsumerEnabled("ghost", true)).rejects.toBeInstanceOf(ApiClientError);
  });
});

describe("ApiClient — contexts methods", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    setSession(null);
    originalFetch = globalThis.fetch;
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("listContexts performs a GET with pagination", async () => {
    const fetchMock = vi.fn((_input: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({
        ok: true,
        data: {
          items: [{ name: "greeting", payload: { hello: "world" }, secretNames: [] }],
          total: 1,
          limit: 50,
          offset: 0,
        },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const client = new ApiClient();
    const result = await client.listContexts({ limit: 50, offset: 0 });

    expect(result.total).toBe(1);
    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/contexts?limit=50&offset=0");
    expect(init?.method).toBe("GET");
  });

  it("createContext performs a POST with the name, payload, and secrets", async () => {
    const fetchMock = vi.fn((_input: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({
        ok: true,
        data: { name: "greeting", payload: { hello: "world" }, secretNames: ["TOKEN"] },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const client = new ApiClient();
    const dto = await client.createContext("greeting", { hello: "world" }, [
      { name: "TOKEN", value: "abc" },
    ]);

    expect(dto.name).toBe("greeting");
    expect(dto.secretNames).toEqual(["TOKEN"]);
    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/contexts");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(
      JSON.stringify({
        name: "greeting",
        payload: { hello: "world" },
        secrets: [{ name: "TOKEN", value: "abc" }],
      }),
    );
  });

  it("updateContext performs a PUT with the payload and the SecretOperation", async () => {
    const fetchMock = vi.fn((_input: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({
        ok: true,
        data: { name: "greeting", payload: { hello: "updated" }, secretNames: ["NEW"] },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const client = new ApiClient();
    const dto = await client.updateContext(
      "greeting",
      { hello: "updated" },
      { upserts: [{ name: "NEW", value: "x" }], deletes: ["OLD"] },
    );

    expect(dto.secretNames).toEqual(["NEW"]);
    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/contexts/greeting");
    expect(init?.method).toBe("PUT");
    expect(init?.body).toBe(
      JSON.stringify({
        payload: { hello: "updated" },
        secrets: { upserts: [{ name: "NEW", value: "x" }], deletes: ["OLD"] },
      }),
    );
  });

  it("deleteContext performs a DELETE and returns the name", async () => {
    const fetchMock = vi.fn((_input: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({ ok: true, data: { name: "greeting" } }),
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const client = new ApiClient();
    const result = await client.deleteContext("greeting");

    expect(result.name).toBe("greeting");
    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/contexts/greeting");
    expect(init?.method).toBe("DELETE");
  });

  it("throws a typed ApiClientError on a contexts failure envelope", async () => {
    globalThis.fetch = vi.fn((_input: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({ ok: false, error: { code: "CONFLICT", message: "already exists" } }, 409),
    ) as unknown as typeof globalThis.fetch;

    const client = new ApiClient();
    await expect(client.createContext("greeting", {}, [])).rejects.toBeInstanceOf(ApiClientError);
  });
});

describe("ApiClient — pause, replay, abort, restart", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    setSession(null);
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("getPauseState performs a GET /api/pause and unwraps the paused flag", async () => {
    const fetchMock = vi.fn((_input: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({ ok: true, data: { paused: true } }),
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const client = new ApiClient();
    const result = await client.getPauseState();

    expect(result.paused).toBe(true);
    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/pause");
    expect(init?.method).toBe("GET");
    expect(init?.body).toBeUndefined();
  });

  it("setPauseState performs a PUT /api/pause with a JSON body", async () => {
    const fetchMock = vi.fn((_input: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({ ok: true, data: { paused: true } }),
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const client = new ApiClient();
    const result = await client.setPauseState(true);

    expect(result.paused).toBe(true);
    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/pause");
    expect(init?.method).toBe("PUT");
    expect(init?.body).toBe(JSON.stringify({ paused: true }));
    expect((init as RequestInit).headers).toMatchObject({ "Content-Type": "application/json" });
  });

  it("replayEvent performs a POST without a body", async () => {
    const fetchMock = vi.fn((_input: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({
        ok: true,
        data: {
          id: "evt-2",
          producerId: "concord.replay",
          producerEventId: "pevt-1#1",
          datetime: "2026-07-05T00:00:00.000Z",
          type: "foo",
          payload: {},
          muted: false,
        },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const client = new ApiClient();
    const result = await client.replayEvent("evt-1");

    expect(result.id).toBe("evt-2");
    expect(result.producerId).toBe("concord.replay");
    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/events/evt-1/replay");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBeUndefined();
  });

  it("abortRun performs a POST without a body", async () => {
    const fetchMock = vi.fn((_input: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({
        ok: true,
        data: {
          id: "run-1",
          state: "ABORTED",
          consumerId: "c-1",
          failure: null,
          event: { id: "evt-1", producerId: "p", producerEventId: "p-1", datetime: "", type: "foo", payload: {}, muted: false },
        },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const client = new ApiClient();
    const result = await client.abortRun("run-1");

    expect(result.state).toBe("ABORTED");
    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/runs/run-1/abort");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBeUndefined();
  });

  it("restartRun performs a POST without a body", async () => {
    const fetchMock = vi.fn((_input: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({
        ok: true,
        data: {
          id: "run-2",
          state: "SUCCEEDED",
          consumerId: "c-1",
          failure: null,
          event: { id: "evt-1", producerId: "p", producerEventId: "p-1", datetime: "", type: "foo", payload: {}, muted: false },
        },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const client = new ApiClient();
    const result = await client.restartRun("run-1");

    expect(result.id).toBe("run-2");
    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/runs/run-1/restart");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBeUndefined();
  });

  it("throws a typed ApiClientError when a replay returns FORBIDDEN", async () => {
    globalThis.fetch = vi.fn((_input: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({ ok: false, error: { code: "FORBIDDEN", message: "not replayable" } }, 403),
    ) as unknown as typeof globalThis.fetch;

    const client = new ApiClient();
    await expect(client.replayEvent("evt-x")).rejects.toBeInstanceOf(ApiClientError);
  });
});

describe("ApiClient — authenticated (adds signing headers)", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    setSession({ sessionId: "session-1", username: "alice", sessionKey: "top-secret-key" });
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    setSession(null);
  });

  it("attaches the four signing headers on a GET request", async () => {
    const fetchMock = vi.fn((_input: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({ ok: true, data: [] }),
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const client = new ApiClient();
    await client.listProducers();

    const [, init] = fetchMock.mock.calls[0];
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["X-Concord-Session"]).toBe("session-1");
    expect(headers["X-Concord-Timestamp"]).toMatch(/^\d+$/);
    expect(headers["X-Concord-Nonce"].length).toBeGreaterThan(0);
    expect(headers["X-Concord-Signature"].length).toBeGreaterThan(0);
  });

  it("signs the canonical path including the /api prefix and excludes the query string", async () => {
    const fetchMock = vi.fn((_input: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({ ok: true, data: { items: [], total: 0, limit: 50, offset: 0 } }),
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const client = new ApiClient();
    await client.listEvents({ limit: 50, offset: 0 });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/events?limit=50&offset=0");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["X-Concord-Session"]).toBe("session-1");
  });
});

describe("ApiClient — UNAUTHORIZED retry path", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    setSession({ sessionId: "session-1", username: "alice", sessionKey: "top-secret-key" });
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    setSession(null);
    setRefreshHandler(null);
    setInvalidHandler(null);
  });

  it("retries once after a successful refresh and returns the retried data", async () => {
    setRefreshHandler(async () => {
      setSession({ sessionId: "session-2", username: "alice", sessionKey: "fresh-key" });
      return true;
    });
    const invalidated = vi.fn();
    setInvalidHandler(invalidated);

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ok: false, error: { code: "UNAUTHORIZED", message: "expired" } }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, data: [{ id: "p-1", enabled: true, disableable: true }] }));
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const client = new ApiClient();
    const result = await client.listProducers();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(invalidated).not.toHaveBeenCalled();
    expect(result).toHaveLength(1);

    const retryInit = fetchMock.mock.calls[1][1] as RequestInit;
    const retryHeaders = retryInit.headers as Record<string, string>;
    expect(retryHeaders["X-Concord-Session"]).toBe("session-2");
  });

  it("invokes the invalid handler and rethrows when refresh returns false", async () => {
    setRefreshHandler(async () => false);
    const invalidated = vi.fn();
    setInvalidHandler(invalidated);

    globalThis.fetch = vi.fn((_input: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({ ok: false, error: { code: "UNAUTHORIZED", message: "expired" } }),
    ) as unknown as typeof globalThis.fetch;

    const client = new ApiClient();
    await expect(client.listProducers()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      message: "expired",
    });
    expect(invalidated).toHaveBeenCalledTimes(1);
  });

  it("invokes the invalid handler when the retried request still fails", async () => {
    setRefreshHandler(async () => {
      setSession({ sessionId: "session-2", username: "alice", sessionKey: "fresh-key" });
      return true;
    });
    const invalidated = vi.fn();
    setInvalidHandler(invalidated);

    globalThis.fetch = vi.fn((_input: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({ ok: false, error: { code: "UNAUTHORIZED", message: "still bad" } }),
    ) as unknown as typeof globalThis.fetch;

    const client = new ApiClient();
    await expect(client.listProducers()).rejects.toBeInstanceOf(ApiClientError);
    expect(invalidated).toHaveBeenCalledTimes(1);
  });

  it("does not retry when the failure is not UNAUTHORIZED", async () => {
    setRefreshHandler(async () => true);
    const invalidated = vi.fn();
    setInvalidHandler(invalidated);

    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ ok: false, error: { code: "NOT_FOUND", message: "missing" } }),
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const client = new ApiClient();
    await expect(client.getEvent("missing")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(invalidated).not.toHaveBeenCalled();
  });

  it("treats a missing refresh handler as a failed refresh", async () => {
    setRefreshHandler(null);
    const invalidated = vi.fn();
    setInvalidHandler(invalidated);

    globalThis.fetch = vi.fn((_input: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({ ok: false, error: { code: "UNAUTHORIZED", message: "expired" } }),
    ) as unknown as typeof globalThis.fetch;

    const client = new ApiClient();
    await expect(client.listProducers()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(invalidated).toHaveBeenCalledTimes(1);
  });
});

describe("ApiClient — peak hours and consumer config", () => {
  beforeEach(() => {
    setSession(null);
    vi.restoreAllMocks();
  });

  it("getPeakHours unwraps the peakHours payload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({ ok: true, data: { peakHours: { start: "09:00", end: "17:00", timezone: "UTC" } } }),
      ),
    );

    const client = new ApiClient();
    const result = await client.getPeakHours();
    expect(result.peakHours).toEqual({ start: "09:00", end: "17:00", timezone: "UTC" });
  });

  it("setPeakHours PUTs the value and returns the stored payload", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ ok: true, data: { peakHours: { start: "10:00", end: "16:00", timezone: "UTC" } } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new ApiClient();
    const result = await client.setPeakHours({ start: "10:00", end: "16:00", timezone: "UTC" });

    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/peak-hours");
    expect(init).toMatchObject({ method: "PUT", body: JSON.stringify({ start: "10:00", end: "16:00", timezone: "UTC" }) });
    expect(result.peakHours).toEqual({ start: "10:00", end: "16:00", timezone: "UTC" });
  });

  it("setPeakHours sends a null body to clear the setting", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ ok: true, data: { peakHours: null } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new ApiClient();
    await client.setPeakHours(null);

    const [, init] = fetchMock.mock.calls[0];
    expect(init).toMatchObject({ method: "PUT", body: "null" });
  });

  it("setConsumerWaitForOffPeak PUTs the flag to the consumer endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        data: { id: "c-1", enabled: true, waitForOffPeak: true, configParameters: [], configValues: {} },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new ApiClient();
    const result = await client.setConsumerWaitForOffPeak("c-1", true);

    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/consumers/c-1/wait-for-off-peak");
    expect(init).toMatchObject({ method: "PUT", body: JSON.stringify({ waitForOffPeak: true }) });
    expect(result.waitForOffPeak).toBe(true);
  });

  it("setConsumerConfig PUTs the values map to the consumer config endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        data: { id: "c-1", enabled: true, waitForOffPeak: false, configParameters: [], configValues: { modelId: "anthropic/x" } },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new ApiClient();
    const result = await client.setConsumerConfig("c-1", { modelId: "anthropic/x" });

    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/consumers/c-1/config");
    expect(init).toMatchObject({ method: "PUT", body: JSON.stringify({ values: { modelId: "anthropic/x" } }) });
    expect(result.configValues).toEqual({ modelId: "anthropic/x" });
  });

  it("setConsumerSecrets PUTs the secrets operation to the consumer secrets endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        ok: true,
        data: { id: "c-1", enabled: true, waitForOffPeak: false, configParameters: [], configValues: {}, secretParameters: [{ key: "githubToken", label: "GitHub token" }], secretNames: ["githubToken"] },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new ApiClient();
    const result = await client.setConsumerSecrets("c-1", { upserts: [{ name: "githubToken", value: "tok-1" }], deletes: [] });

    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/consumers/c-1/secrets");
    expect(init).toMatchObject({ method: "PUT", body: JSON.stringify({ secrets: { upserts: [{ name: "githubToken", value: "tok-1" }], deletes: [] } }) });
    expect(result.secretNames).toEqual(["githubToken"]);
  });
});

describe("ApiClient — run forms", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    setSession(null);
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("listRunForms performs a GET and returns the items array", async () => {
    const fetchMock = vi.fn((_input: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({
        ok: true,
        data: {
          items: [
            {
              id: "form-1",
              runId: "run-1",
              consumerId: "c-1",
              round: 1,
              status: "PENDING",
              prompt: "Which?",
              context: "",
              fields: [{ key: "note", label: "Note", inputType: "text", defaultValue: "" }],
              answers: null,
              createdAt: "2026-07-06T08:00:00.000Z",
              answeredAt: null,
            },
          ],
        },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const client = new ApiClient();
    const result = await client.listRunForms("run-1");

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("form-1");
    expect(result[0].status).toBe("PENDING");
    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/runs/run-1/forms");
    expect(init?.method).toBe("GET");
  });

  it("submitRunForm performs a POST with an answers body and returns the updated form", async () => {
    const fetchMock = vi.fn((_input: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({
        ok: true,
        data: {
          id: "form-1",
          runId: "run-1",
          consumerId: "c-1",
          round: 1,
          status: "ANSWERED",
          prompt: "Which?",
          fields: [{ key: "note", label: "Note", inputType: "text", defaultValue: "" }],
          answers: { note: "ok" },
          createdAt: "2026-07-06T08:00:00.000Z",
          answeredAt: "2026-07-06T08:05:00.000Z",
        },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const client = new ApiClient();
    const result = await client.submitRunForm("run-1", "form-1", { note: "ok" });

    expect(result.status).toBe("ANSWERED");
    expect(result.answers).toEqual({ note: "ok" });
    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/runs/run-1/forms/form-1/submit");
    expect(init).toMatchObject({ method: "POST", body: JSON.stringify({ answers: { note: "ok" } }) });
  });
});

describe("ApiClient — event templates", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    setSession(null);
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("listEventTemplates performs a GET and returns the templates array", async () => {
    const fetchMock = vi.fn((_input: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({
        ok: true,
        data: [
          {
            id: "raw-json",
            label: "Raw JSON",
            description: "desc",
            producerId: "web-ui",
            fields: [{ key: "json", label: "JSON", inputType: "textarea", defaultValue: "" }],
          },
        ],
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const client = new ApiClient();
    const result = await client.listEventTemplates();

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("raw-json");
    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/event-templates");
    expect(init?.method).toBe("GET");
  });

  it("emitEventTemplate performs a POST with an answers body and returns the created event", async () => {
    const fetchMock = vi.fn((_input: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({
        ok: true,
        data: {
          id: "evt-1",
          producerId: "web-ui",
          producerEventId: "pevt-1",
          datetime: "2026-07-08T10:00:00Z",
          type: "rawjson",
          payload: { eventId: "pevt-1" },
          muted: false,
        },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const client = new ApiClient();
    const result = await client.emitEventTemplate("raw-json", { json: '{"eventId":"pevt-1"}' });

    expect(result.id).toBe("evt-1");
    expect(result.type).toBe("rawjson");
    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/event-templates/raw-json/emit");
    expect(init).toMatchObject({ method: "POST", body: JSON.stringify({ answers: { json: '{"eventId":"pevt-1"}' } }) });
  });
});

describe("ApiClient — logs methods", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    setSession(null);
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("queryLogs builds a well-formed URL with the query string separated by '?'", async () => {
    const fetchMock = vi.fn((_input: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({
        ok: true,
        data: {
          items: [
            { timestamp: "2026-07-11T00:00:00.000Z", level: "info", source: "concord-server", message: "hi" },
          ],
          total: 1,
          limit: 50,
          offset: 0,
        },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const client = new ApiClient();
    const result = await client.queryLogs({ limit: 50, offset: 0 });

    expect(result.total).toBe(1);
    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/logs?limit=50&offset=0");
    expect(init?.method).toBe("GET");
  });

  it("queryLogs appends filters and keeps the query string well-formed", async () => {
    const fetchMock = vi.fn((_input: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({ ok: true, data: { items: [], total: 0, limit: 50, offset: 0 } }),
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const client = new ApiClient();
    await client.queryLogs({ limit: 50, offset: 10, level: "error", source: "concord-server", text: "boom" });

    const [path] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/logs?limit=50&offset=10&level=error&source=concord-server&text=boom");
  });

  it("queryLogs requests /api/logs with no query string when no params are given", async () => {
    const fetchMock = vi.fn((_input: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({ ok: true, data: { items: [], total: 0, limit: 50, offset: 0 } }),
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const client = new ApiClient();
    await client.queryLogs();

    const [path] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/logs");
  });

  it("listLogSources performs a GET on /api/logs/sources", async () => {
    const fetchMock = vi.fn((_input: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({ ok: true, data: { sources: ["concord-server", "agent"] } }),
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const client = new ApiClient();
    const result = await client.listLogSources();

    expect(result).toEqual(["concord-server", "agent"]);
    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe("/api/logs/sources");
    expect(init?.method).toBe("GET");
  });
});
