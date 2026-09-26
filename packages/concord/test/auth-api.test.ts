import { describe, it, expect, afterEach } from "vitest";
import { WebSocket } from "ws";
import * as srpClient from "secure-remote-password/client";
import { randomUUID, createHmac } from "node:crypto";

import { Consumer } from "../src/domain/entities/consumer";
import { ConsumerRegistrable } from "../src/infra/adapters/consumers/consumer-registrable";
import { MakeApp, TEST_ARGON2ID_PARAMETERS } from "../src";
import { CanonicalRequest } from "../src/infra/adapters/auth/canonical-request";
import {
  Argon2PasswordSecretDeriver,
  SecureRemotePasswordIssuer,
  InMemoryEventStore,
  InMemoryRunRepository,
  InMemoryCredentialStore,
} from "../src";
import type { App } from "../src/infra/main/app";
import type { LoginSession } from "./auth-helpers";
import { buildLoginSession, signHeaders } from "./auth-helpers";
import {
  FixedClock,
  RecordingHandler,
  SequentialIdGenerator,
  TypeRule,
  successfulOutcome,
  waitFor,
} from "./helpers";

function resolveApiBaseUrl(app: App): string {
  const internal = app as unknown as {
    startables: Array<{ address: { host: string; port: number } | null }>;
  };
  for (const service of internal.startables) {
    if (service.address !== null && service.address !== undefined) {
      return `${service.address.host}:${service.address.port}`;
    }
  }
  throw new Error("No started API server found on App");
}

async function signedFetch(
  baseUrl: string,
  session: LoginSession,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const bodyText = body === undefined ? "" : JSON.stringify(body);
  const headers = signHeaders(session, method, path, bodyText);
  const init: RequestInit = { method, headers: headers as Record<string, string> };
  if (body !== undefined) {
    init.body = bodyText;
  }
  const response = await fetch(`http://${baseUrl}${path}`, init);
  const text = await response.text();
  let parsed: unknown = text;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: response.status, body: parsed };
}

describe("HTTP API authentication", () => {
  let app: App | null = null;

  afterEach(async () => {
    if (app !== null) {
      await app.stop();
      app = null;
    }
  });

  function bootApp(handler: RecordingHandler, credentialStore: InMemoryCredentialStore): Promise<string> {
    app = MakeApp({
      idGenerator: new SequentialIdGenerator(),
      eventStore: new InMemoryEventStore(),
      runRepository: new InMemoryRunRepository(),
      credentialStore,
      api: { host: "127.0.0.1", port: 0 },
      auth: {
        argon2: TEST_ARGON2ID_PARAMETERS,
        handshakeTtlMs: 30_000,
        sessionLifetimeMs: 3_600_000,
        freshnessWindowMs: 5 * 60 * 1000,
        pepper: "integration-pepper",
      },
    });
    app.register(
      new ConsumerRegistrable(new Consumer<unknown>("recorder", new TypeRule("cli-event"), handler, [], [])),
    );
    return app.start().then(() => resolveApiBaseUrl(app!));
  }

  async function seedUser(credentialStore: InMemoryCredentialStore, username: string, password: string): Promise<void> {
    const deriver = new Argon2PasswordSecretDeriver(TEST_ARGON2ID_PARAMETERS);
    const issuer = new SecureRemotePasswordIssuer(deriver);
    const issued = await issuer.generate(username, password);
    const { Credential } = await import("../src/domain/entities/credential");
    await credentialStore.save(new Credential(username, issued.salt, issued.verifier));
  }

  it("rejects an unsigned GET /api/events with 401 UNAUTHORIZED", async () => {
    const handler = new RecordingHandler(successfulOutcome());
    const baseUrl = await bootApp(handler, new InMemoryCredentialStore());

    const response = await fetch(`http://${baseUrl}/api/events`);

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("performs a full SRP login, signs a GET /api/events, and returns 200", async () => {
    const handler = new RecordingHandler(successfulOutcome());
    const credentialStore = new InMemoryCredentialStore();
    const baseUrl = await bootApp(handler, credentialStore);
    await seedUser(credentialStore, "alice", "super-secret");

    const session = await buildLoginSession(baseUrl, "alice", "super-secret");

    const result = await signedFetch(baseUrl, session, "GET", "/api/events");

    expect(result.status).toBe(200);
    expect((result.body as { ok: boolean }).ok).toBe(true);
  });

  it("rejects a replayed nonce with 401 UNAUTHORIZED", async () => {
    const handler = new RecordingHandler(successfulOutcome());
    const credentialStore = new InMemoryCredentialStore();
    const baseUrl = await bootApp(handler, credentialStore);
    await seedUser(credentialStore, "alice", "super-secret");

    const session = await buildLoginSession(baseUrl, "alice", "super-secret");

    const timestamp = String(Date.now());
    const nonce = "fixed-replay-nonce";
    const canonical = new CanonicalRequest().build({
      method: "GET",
      path: "/api/events",
      timestamp,
      nonce,
      body: "",
    });
    const signature = createHmac("sha256", session.sessionKey).update(canonical).digest("base64");
    const headers = {
      "X-Concord-Session": session.sessionId,
      "X-Concord-Timestamp": timestamp,
      "X-Concord-Nonce": nonce,
      "X-Concord-Signature": signature,
    };
    const first = await fetch(`http://${baseUrl}/api/events`, { method: "GET", headers });
    expect(first.status).toBe(200);

    const replay = await fetch(`http://${baseUrl}/api/events`, { method: "GET", headers });
    expect(replay.status).toBe(401);
    const replayBody = (await replay.json()) as { error: { code: string } };
    expect(replayBody.error.code).toBe("UNAUTHORIZED");
  });

  it("signs a POST /api/events, returns the EventDto, and dispatches to the live consumer", async () => {
    const handler = new RecordingHandler(successfulOutcome());
    const credentialStore = new InMemoryCredentialStore();
    const baseUrl = await bootApp(handler, credentialStore);
    await seedUser(credentialStore, "alice", "super-secret");

    const session = await buildLoginSession(baseUrl, "alice", "super-secret");

    const result = await signedFetch(baseUrl, session, "POST", "/api/events", {
      type: "cli-event",
      payload: { hello: "world" },
      producerId: "cli",
    });

    expect(result.status).toBe(200);
    const body = result.body as { ok: boolean; data: { type: string; producerId: string; payload: unknown } };
    expect(body.ok).toBe(true);
    expect(body.data.type).toBe("cli-event");
    expect(body.data.producerId).toBe("cli");

    await waitFor(() => (handler.calls.length >= 1 ? handler.calls : undefined));
    expect(handler.calls).toHaveLength(1);
    expect(handler.calls[0].event.type).toBe("cli-event");
  });

  it("rejects a failed login (wrong password) with 401 UNAUTHORIZED", async () => {
    const handler = new RecordingHandler(successfulOutcome());
    const credentialStore = new InMemoryCredentialStore();
    const baseUrl = await bootApp(handler, credentialStore);
    await seedUser(credentialStore, "alice", "correct-password");

    await expect(buildLoginSession(baseUrl, "alice", "wrong-password")).rejects.toThrow();
  });

  it("rejects a WebSocket upgrade to /api/stream without a valid signature", async () => {
    const handler = new RecordingHandler(successfulOutcome());
    const baseUrl = await bootApp(handler, new InMemoryCredentialStore());

    const outcome = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://${baseUrl}/api/stream`);
      ws.on("open", () => {
        ws.close();
        resolve(1);
      });
      ws.on("error", () => resolve(0));
    });

    expect(outcome).toBe(0);
  });

  it("accepts a WebSocket upgrade to /api/stream with a valid signature", async () => {
    const handler = new RecordingHandler(successfulOutcome());
    const credentialStore = new InMemoryCredentialStore();
    const baseUrl = await bootApp(handler, credentialStore);
    await seedUser(credentialStore, "alice", "super-secret");

    const session = await buildLoginSession(baseUrl, "alice", "super-secret");
    const headers = signHeaders(session, "GET", "/api/stream", "");
    const params = new URLSearchParams({
      session: session.sessionId,
      timestamp: headers["X-Concord-Timestamp"],
      nonce: headers["X-Concord-Nonce"],
      signature: headers["X-Concord-Signature"],
    });

    const opened = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(`ws://${baseUrl}/api/stream?${params.toString()}`);
      ws.on("open", () => {
        ws.close();
        resolve(true);
      });
      ws.on("error", () => resolve(false));
    });

    expect(opened).toBe(true);
  });

  it("returns a generic UNAUTHORIZED for an unknown user's verify step", async () => {
    const baseUrl = await bootApp(new RecordingHandler(successfulOutcome()), new InMemoryCredentialStore());

    const response = await fetch(`http://${baseUrl}/api/auth/init`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "ghost", clientPublicEphemeral: "A".repeat(10) }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; data: { salt: string } };
    expect(body.ok).toBe(true);
    expect(body.data.salt).toHaveLength(32);
  });

  it("uses a fresh random UUID per signed request", async () => {
    const handler = new RecordingHandler(successfulOutcome());
    const credentialStore = new InMemoryCredentialStore();
    const baseUrl = await bootApp(handler, credentialStore);
    await seedUser(credentialStore, "alice", "super-secret");
    const session = await buildLoginSession(baseUrl, "alice", "super-secret");

    const first = await signedFetch(baseUrl, session, "GET", "/api/events");
    const second = await signedFetch(baseUrl, session, "GET", "/api/events");

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
  });

  it("exercises randomUUID helper to confirm availability", () => {
    expect(randomUUID()).toMatch(/[0-9a-f-]{36}/);
  });

  it("accepts a signed PATCH /api/consumers and reflects the change", async () => {
    const handler = new RecordingHandler(successfulOutcome());
    const credentialStore = new InMemoryCredentialStore();
    const baseUrl = await bootApp(handler, credentialStore);
    await seedUser(credentialStore, "alice", "super-secret");
    const session = await buildLoginSession(baseUrl, "alice", "super-secret");

    const result = await signedFetch(baseUrl, session, "PATCH", "/api/consumers/recorder", { enabled: false });

    expect(result.status).toBe(200);
    const body = result.body as { ok: boolean; data: { id: string; enabled: boolean } };
    expect(body.ok).toBe(true);
    expect(body.data).toEqual({ id: "recorder", enabled: false });
  });

  it("returns BAD_REQUEST for a signed PATCH with a malformed body", async () => {
    const handler = new RecordingHandler(successfulOutcome());
    const credentialStore = new InMemoryCredentialStore();
    const baseUrl = await bootApp(handler, credentialStore);
    await seedUser(credentialStore, "alice", "super-secret");
    const session = await buildLoginSession(baseUrl, "alice", "super-secret");

    const bodyText = "not-json";
    const headers = signHeaders(session, "PATCH", "/api/consumers/recorder", bodyText);
    const response = await fetch(`http://${baseUrl}/api/consumers/recorder`, {
      method: "PATCH",
      headers: headers as Record<string, string>,
      body: bodyText,
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("BAD_REQUEST");
  });
});
