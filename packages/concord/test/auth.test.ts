import { describe, it, expect } from "vitest";

import { Credential } from "../src/domain/entities/credential";
import {
  HandshakeExpiredError,
  InvalidProofError,
  InvalidSignatureError,
  ReplayDetectedError,
  SessionExpiredError,
  StaleRequestError,
  UserAlreadyExistsError,
  UserNotFoundError,
} from "../src/domain/exceptions/errors";
import { CreateUserInteractor } from "../src/domain/interactors/create-user-interactor";
import { DeleteUserInteractor } from "../src/domain/interactors/delete-user-interactor";
import { BeginLoginInteractor } from "../src/domain/interactors/begin-login-interactor";
import { CompleteLoginInteractor } from "../src/domain/interactors/complete-login-interactor";
import { AuthenticateRequestInteractor } from "../src/domain/interactors/authenticate-request-interactor";
import { EmitEventInteractor } from "../src/domain/interactors/emit-event-interactor";
import { CanonicalRequest } from "../src/infra/adapters/auth/canonical-request";
import {
  FakeCredentialIssuer,
  FakeHandshakeStore,
  FakeNonceCache,
  FakeSessionStore,
  FakeSignatureVerifier,
  FakeSrpHandshake,
  FixedClock,
  InMemoryCredentialStoreFake,
  RecordingEventSink,
  SequentialIdGenerator,
} from "./helpers";

const FRESHNESS_MS = 60_000;
const SESSION_LIFETIME_MS = 3_600_000;

describe("CreateUser use case", () => {
  it("saves a credential when the user does not exist", async () => {
    const store = new InMemoryCredentialStoreFake();
    const issuer = new FakeCredentialIssuer({ salt: "salt-1", verifier: "verifier-1" });
    const create = new CreateUserInteractor(store, issuer);

    const descriptor = await create.create("alice", "password");

    expect(descriptor).toEqual({ username: "alice" });
    expect(issuer.generateCalls).toEqual([{ username: "alice", password: "password" }]);
    expect(store.saved).toEqual([
      new Credential("alice", "salt-1", "verifier-1"),
    ]);
  });

  it("throws UserAlreadyExistsError when the user exists", async () => {
    const store = new InMemoryCredentialStoreFake();
    store.seed(new Credential("alice", "salt-1", "verifier-1"));
    const issuer = new FakeCredentialIssuer({ salt: "salt-1", verifier: "verifier-1" });
    const create = new CreateUserInteractor(store, issuer);

    await expect(create.create("alice", "password")).rejects.toBeInstanceOf(UserAlreadyExistsError);
    expect(issuer.generateCalls).toHaveLength(0);
    expect(store.saved).toHaveLength(0);
  });
});

describe("DeleteUser use case", () => {
  it("deletes after confirming the user exists", async () => {
    const store = new InMemoryCredentialStoreFake();
    store.seed(new Credential("alice", "salt-1", "verifier-1"));
    const del = new DeleteUserInteractor(store);

    await del.delete("alice");

    expect(store.deleted).toEqual(["alice"]);
  });

  it("surfaces UserNotFoundError when the user is missing", async () => {
    const store = new InMemoryCredentialStoreFake();
    const del = new DeleteUserInteractor(store);

    await expect(del.delete("ghost")).rejects.toBeInstanceOf(UserNotFoundError);
    expect(store.deleted).toHaveLength(0);
  });
});

describe("BeginLogin use case", () => {
  function build() {
    const store = new InMemoryCredentialStoreFake();
    const handshake = new FakeSrpHandshake(
      { serverSecret: "secret-1", serverPublicEphemeral: "B" },
      { sessionKey: "k", serverSessionProof: "proof" },
      { salt: "fake-salt", serverPublicEphemeral: "fake-B" },
    );
    const handshakeStore = new FakeHandshakeStore();
    const ids = new SequentialIdGenerator();
    const begin = new BeginLoginInteractor(store, handshake, handshakeStore, ids);
    return { store, handshake, handshakeStore, begin };
  }

  it("returns the real salt and server ephemeral for a known user and stores the handshake", async () => {
    const { store, begin, handshakeStore } = build();
    store.seed(new Credential("alice", "real-salt", "verifier"));

    const result = await begin.begin("alice", "A");

    expect(result.salt).toBe("real-salt");
    expect(result.serverPublicEphemeral).toBe("B");
    expect(result.handshakeId).toBe("id-1");
    const stored = handshakeStore.store.get("id-1");
    expect(stored).toEqual({
      serverSecret: "secret-1",
      clientPublicEphemeral: "A",
      username: "alice",
      fake: false,
    });
  });

  it("returns a plausible salt and ephemeral for an unknown user without throwing", async () => {
    const { begin, handshakeStore } = build();

    const result = await begin.begin("ghost", "A");

    expect(result.salt).toBe("fake-salt");
    expect(result.serverPublicEphemeral).toBe("fake-B");
    const stored = handshakeStore.store.get(result.handshakeId);
    expect(stored?.fake).toBe(true);
  });
});

describe("CompleteLogin use case", () => {
  function build(throwOnComplete: unknown = null) {
    const handshakeStore = new FakeHandshakeStore();
    const store = new InMemoryCredentialStoreFake();
    const handshake = new FakeSrpHandshake(
      { serverSecret: "secret-1", serverPublicEphemeral: "B" },
      { sessionKey: "session-key", serverSessionProof: "M2" },
      { salt: "fake-salt", serverPublicEphemeral: "fake-B" },
      throwOnComplete,
    );
    const sessionStore = new FakeSessionStore();
    const ids = new SequentialIdGenerator();
    const clock = new FixedClock(new Date("2026-07-04T00:00:00Z"));
    const complete = new CompleteLoginInteractor(
      handshakeStore,
      store,
      handshake,
      sessionStore,
      ids,
      clock,
      SESSION_LIFETIME_MS,
    );
    return { handshakeStore, store, handshake, sessionStore, complete };
  }

  it("succeeds for a valid proof and creates a session", async () => {
    const { handshakeStore, store, complete, sessionStore } = build();
    store.seed(new Credential("alice", "salt", "verifier"));
    handshakeStore.store.set("h-1", {
      serverSecret: "secret-1",
      clientPublicEphemeral: "A",
      username: "alice",
      fake: false,
    });

    const result = await complete.complete("h-1", "A", "M1");

    expect(result.sessionId).toBe("session-1");
    expect(result.username).toBe("alice");
    expect(result.serverSessionProof).toBe("M2");
    const session = sessionStore.sessions.get("session-1");
    expect(session?.username).toBe("alice");
    expect(session?.sessionKey).toBe("session-key");
  });

  it("throws InvalidProofError for a bad proof", async () => {
    const { handshakeStore, store, complete } = build(new InvalidProofError());
    store.seed(new Credential("alice", "salt", "verifier"));
    handshakeStore.store.set("h-1", {
      serverSecret: "secret-1",
      clientPublicEphemeral: "A",
      username: "alice",
      fake: false,
    });

    await expect(complete.complete("h-1", "A", "WRONG")).rejects.toBeInstanceOf(InvalidProofError);
  });

  it("throws HandshakeExpiredError for an unknown handshake id", async () => {
    const { complete } = build();

    await expect(complete.complete("missing", "A", "M1")).rejects.toBeInstanceOf(HandshakeExpiredError);
  });

  it("throws for a fake-user handshake", async () => {
    const { handshakeStore, complete } = build();
    handshakeStore.store.set("h-1", {
      serverSecret: "",
      clientPublicEphemeral: "A",
      username: "ghost",
      fake: true,
    });

    await expect(complete.complete("h-1", "A", "M1")).rejects.toBeInstanceOf(InvalidProofError);
  });
});

describe("AuthenticateRequest use case", () => {
  function build(now: Date = new Date("2026-07-04T12:00:00Z")) {
    const sessionStore = new FakeSessionStore();
    const verifier = new FakeSignatureVerifier();
    const nonceCache = new FakeNonceCache();
    const clock = new FixedClock(now);
    const canonical = new CanonicalRequest();
    const authenticate = new AuthenticateRequestInteractor(
      sessionStore,
      verifier,
      nonceCache,
      clock,
      canonical,
      FRESHNESS_MS,
    );
    return { sessionStore, verifier, nonceCache, authenticate };
  }

  function signedRequest(overrides: Partial<{
    method: string; path: string; body: string;
    session: string; timestamp: string; nonce: string; signature: string;
  }> = {}) {
    return {
      method: "GET",
      path: "/api/events",
      body: "",
      session: "session-1",
      timestamp: String(new Date("2026-07-04T12:00:00Z").getTime()),
      nonce: "nonce-1",
      signature: "sig",
      ...overrides,
    };
  }

  it("returns the username for a valid signature", async () => {
    const { sessionStore, authenticate } = build();
    sessionStore.sessions.set("session-1", {
      username: "alice",
      sessionKey: "key",
      expiresAt: new Date(Date.now() + 1000),
    });

    const username = await authenticate.authenticate(signedRequest());

    expect(username).toBe("alice");
  });

  it("throws SessionExpiredError for an unknown session", async () => {
    const { authenticate } = build();

    await expect(authenticate.authenticate(signedRequest())).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it("throws StaleRequestError for a stale timestamp", async () => {
    const { sessionStore, authenticate } = build();
    sessionStore.sessions.set("session-1", {
      username: "alice",
      sessionKey: "key",
      expiresAt: new Date(Date.now() + 1000),
    });

    await expect(
      authenticate.authenticate(signedRequest({ timestamp: String(new Date("2020-01-01T00:00:00Z").getTime()) })),
    ).rejects.toBeInstanceOf(StaleRequestError);
  });

  it("throws ReplayDetectedError when a nonce is seen twice", async () => {
    const { sessionStore, nonceCache, authenticate } = build();
    sessionStore.sessions.set("session-1", {
      username: "alice",
      sessionKey: "key",
      expiresAt: new Date(Date.now() + 1000),
    });
    nonceCache.willReturnAlreadySeen();

    await expect(authenticate.authenticate(signedRequest())).rejects.toBeInstanceOf(ReplayDetectedError);
  });

  it("throws InvalidSignatureError when the signature does not match", async () => {
    const { sessionStore, verifier, authenticate } = build();
    sessionStore.sessions.set("session-1", {
      username: "alice",
      sessionKey: "key",
      expiresAt: new Date(Date.now() + 1000),
    });
    verifier.willReturn(false);

    await expect(authenticate.authenticate(signedRequest())).rejects.toBeInstanceOf(InvalidSignatureError);
  });
});

describe("EmitEvent use case", () => {
  it("builds an event with the given producer id and emits it through the sink", async () => {
    const sink = new RecordingEventSink();
    const ids = new SequentialIdGenerator();
    const clock = new FixedClock(new Date("2026-07-04T00:00:00Z"));
    const emit = new EmitEventInteractor(sink, ids, clock);

    const descriptor = await emit.emit("foo", { n: 1 }, "cli");

    expect(descriptor.id).toBe("id-1");
    expect(descriptor.producerId).toBe("cli");
    expect(descriptor.producerEventId).toBe("id-1");
    expect(descriptor.datetime.toISOString()).toBe("2026-07-04T00:00:00.000Z");
    expect(descriptor.type).toBe("foo");
    expect(descriptor.payload).toEqual({ n: 1 });
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0].id).toBe("id-1");
    expect(sink.events[0].producerId).toBe("cli");
  });
});
