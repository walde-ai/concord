import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "events";
import { WebSocket } from "ws";

import { StreamBroadcaster } from "../src/infra/adapters/api/stream-broadcaster";
import { Event } from "../src/domain/entities/event";
import type { RunActivityFrame } from "../src/infra/adapters/opencode/run-activity-emitter";

class FakeSocket extends EventEmitter {
  public constructor(public readyState: number) {
    super();
  }
  public send(_data: string): void {}
}

function makeFrame(runId: string): RunActivityFrame {
  return {
    runId,
    consumerId: "c-1",
    sessionId: "sess-1",
    kind: "message.part.updated",
    payload: { part: { type: "text", text: "hello" } },
    at: "2026-07-11T10:00:00.000Z",
  };
}

// The ws library delivers text-frame payloads as Buffer (RawData), so the
// helpers emit exactly what production delivers — a string payload would let a
// string-only handler pass the suite while dropping every real client frame.
function subscribe(socket: FakeSocket, runId: string): void {
  socket.emit("message", Buffer.from(JSON.stringify({ type: "subscribe", runId }), "utf8"));
}

function unsubscribe(socket: FakeSocket, runId: string): void {
  socket.emit("message", Buffer.from(JSON.stringify({ type: "unsubscribe", runId }), "utf8"));
}

describe("StreamBroadcaster — client set", () => {
  it("hasClients returns false before a client is added and true after", () => {
    const broadcaster = new StreamBroadcaster();
    expect(broadcaster.hasClients()).toBe(false);
    expect(broadcaster.hasSubscribers()).toBe(false);

    const socket = new FakeSocket(WebSocket.OPEN);
    broadcaster.addClient(socket as unknown as WebSocket);

    expect(broadcaster.hasClients()).toBe(true);
    expect(broadcaster.hasSubscribers()).toBe(true);

    socket.emit("close");
    expect(broadcaster.hasClients()).toBe(false);
  });
});

describe("StreamBroadcaster — per-run activity routing", () => {
  it("writes a run.activity frame only to sockets subscribed to that run", () => {
    const broadcaster = new StreamBroadcaster();
    const socketX = new FakeSocket(WebSocket.OPEN);
    const socketY = new FakeSocket(WebSocket.OPEN);
    const spyX = vi.spyOn(socketX, "send");
    const spyY = vi.spyOn(socketY, "send");
    broadcaster.addClient(socketX as unknown as WebSocket);
    broadcaster.addClient(socketY as unknown as WebSocket);
    subscribe(socketX, "run-x");
    subscribe(socketY, "run-y");

    broadcaster.emit(makeFrame("run-x"));

    expect(spyX).toHaveBeenCalledTimes(1);
    expect(spyY).not.toHaveBeenCalled();
    const parsed = JSON.parse(spyX.mock.calls[0][0] as string);
    expect(parsed.type).toBe("run.activity");
    expect(parsed.data.runId).toBe("run-x");
  });

  it("drops the frame when no client is subscribed to the run (no-op emit)", () => {
    const broadcaster = new StreamBroadcaster();
    const socket = new FakeSocket(WebSocket.OPEN);
    const spy = vi.spyOn(socket, "send");
    broadcaster.addClient(socket as unknown as WebSocket);

    expect(() => broadcaster.emit(makeFrame("run-1"))).not.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });

  it("stops routing to a socket after it unsubscribes", () => {
    const broadcaster = new StreamBroadcaster();
    const socket = new FakeSocket(WebSocket.OPEN);
    const spy = vi.spyOn(socket, "send");
    broadcaster.addClient(socket as unknown as WebSocket);
    subscribe(socket, "run-1");

    broadcaster.emit(makeFrame("run-1"));
    expect(spy).toHaveBeenCalledTimes(1);

    unsubscribe(socket, "run-1");
    broadcaster.emit(makeFrame("run-1"));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("removes every per-run subscription when the socket closes", () => {
    const broadcaster = new StreamBroadcaster();
    const socket = new FakeSocket(WebSocket.OPEN);
    const spy = vi.spyOn(socket, "send");
    broadcaster.addClient(socket as unknown as WebSocket);
    subscribe(socket, "run-1");
    subscribe(socket, "run-2");

    socket.emit("close");

    broadcaster.emit(makeFrame("run-1"));
    broadcaster.emit(makeFrame("run-2"));
    expect(spy).not.toHaveBeenCalled();
  });

  it("drops a socket that throws on send from every subscription set", () => {
    const broadcaster = new StreamBroadcaster();
    const socket = new FakeSocket(WebSocket.OPEN);
    vi.spyOn(socket, "send").mockImplementation(() => {
      throw new Error("broken pipe");
    });
    broadcaster.addClient(socket as unknown as WebSocket);
    subscribe(socket, "run-1");

    expect(broadcaster.hasClients()).toBe(true);
    broadcaster.emit(makeFrame("run-1"));
    expect(broadcaster.hasClients()).toBe(false);
  });

  it("does not write to a socket that is not in the OPEN state", () => {
    const broadcaster = new StreamBroadcaster();
    const socket = new FakeSocket(WebSocket.CONNECTING);
    const spy = vi.spyOn(socket, "send");
    broadcaster.addClient(socket as unknown as WebSocket);
    subscribe(socket, "run-1");

    broadcaster.emit(makeFrame("run-1"));

    expect(spy).not.toHaveBeenCalled();
  });

  it("ignores malformed and unknown client messages", () => {
    const broadcaster = new StreamBroadcaster();
    const socket = new FakeSocket(WebSocket.OPEN);
    const spy = vi.spyOn(socket, "send");
    broadcaster.addClient(socket as unknown as WebSocket);

    socket.emit("message", Buffer.from("not-json", "utf8"));
    socket.emit("message", Buffer.from(JSON.stringify({ type: "unknown", runId: "run-1" }), "utf8"));
    socket.emit("message", Buffer.from(JSON.stringify({ type: "subscribe" }), "utf8"));
    socket.emit("message", Buffer.from(JSON.stringify({ type: "subscribe", runId: "" }), "utf8"));

    // Nothing subscribed, so an emit is a no-op and never reaches send.
    broadcaster.emit(makeFrame("run-1"));
    expect(spy).not.toHaveBeenCalled();
  });

  it("registers a subscription from an ArrayBuffer text payload", () => {
    const broadcaster = new StreamBroadcaster();
    const socket = new FakeSocket(WebSocket.OPEN);
    const spy = vi.spyOn(socket, "send");
    broadcaster.addClient(socket as unknown as WebSocket);

    const encoded = new TextEncoder().encode(JSON.stringify({ type: "subscribe", runId: "run-1" }));
    socket.emit("message", encoded.buffer, false);

    broadcaster.emit(makeFrame("run-1"));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("registers a subscription from a fragmented Buffer[] text payload", () => {
    const broadcaster = new StreamBroadcaster();
    const socket = new FakeSocket(WebSocket.OPEN);
    const spy = vi.spyOn(socket, "send");
    broadcaster.addClient(socket as unknown as WebSocket);

    const whole = Buffer.from(JSON.stringify({ type: "subscribe", runId: "run-1" }), "utf8");
    socket.emit("message", [whole.subarray(0, 5), whole.subarray(5)], false);

    broadcaster.emit(makeFrame("run-1"));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("ignores binary frames even when the payload is valid JSON", () => {
    const broadcaster = new StreamBroadcaster();
    const socket = new FakeSocket(WebSocket.OPEN);
    const spy = vi.spyOn(socket, "send");
    broadcaster.addClient(socket as unknown as WebSocket);

    socket.emit("message", Buffer.from(JSON.stringify({ type: "subscribe", runId: "run-1" }), "utf8"), true);

    broadcaster.emit(makeFrame("run-1"));
    expect(spy).not.toHaveBeenCalled();
  });

  it("registers per-run subscriptions from the binary frames ws delivers (Buffer, not string)", () => {
    const broadcaster = new StreamBroadcaster();
    const socket = new FakeSocket(WebSocket.OPEN);
    const spy = vi.spyOn(socket, "send");
    broadcaster.addClient(socket as unknown as WebSocket);

    // Real ws message payload: a UTF-8 Buffer carrying the subscribe text.
    subscribe(socket, "run-bin");

    broadcaster.emit(makeFrame("run-bin"));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(spy.mock.calls[0][0] as string)).toEqual({
      type: "run.activity",
      data: makeFrame("run-bin"),
    });
  });

  it("decodes an ArrayBuffer-delivered subscribe frame as well", () => {
    const broadcaster = new StreamBroadcaster();
    const socket = new FakeSocket(WebSocket.OPEN);
    const spy = vi.spyOn(socket, "send");
    broadcaster.addClient(socket as unknown as WebSocket);

    const text = JSON.stringify({ type: "subscribe", runId: "run-ab" });
    socket.emit("message", new TextEncoder().encode(text).buffer);

    broadcaster.emit(makeFrame("run-ab"));
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("StreamBroadcaster — lifecycle frames fan out globally", () => {
  it("still sends lifecycle frames to every connected client regardless of subscriptions", () => {
    const broadcaster = new StreamBroadcaster();
    const subscribed = new FakeSocket(WebSocket.OPEN);
    const unsubscribed = new FakeSocket(WebSocket.OPEN);
    const spySub = vi.spyOn(subscribed, "send");
    const spyUnsub = vi.spyOn(unsubscribed, "send");
    broadcaster.addClient(subscribed as unknown as WebSocket);
    broadcaster.addClient(unsubscribed as unknown as WebSocket);
    subscribe(subscribed, "run-1");

    const event = new Event<unknown>("evt-1", "p-1", "pe-1", new Date("2026-07-11T10:00:00Z"), "foo", {});
    broadcaster.eventCreated(event);

    expect(spySub).toHaveBeenCalledTimes(1);
    expect(spyUnsub).toHaveBeenCalledTimes(1);
  });
});
