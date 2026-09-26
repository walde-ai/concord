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

function subscribe(socket: FakeSocket, runId: string): void {
  socket.emit("message", JSON.stringify({ type: "subscribe", runId }));
}

function unsubscribe(socket: FakeSocket, runId: string): void {
  socket.emit("message", JSON.stringify({ type: "unsubscribe", runId }));
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

    socket.emit("message", "not-json");
    socket.emit("message", JSON.stringify({ type: "unknown", runId: "run-1" }));
    socket.emit("message", JSON.stringify({ type: "subscribe" }));
    socket.emit("message", JSON.stringify({ type: "subscribe", runId: "" }));

    // Nothing subscribed, so an emit is a no-op and never reaches send.
    broadcaster.emit(makeFrame("run-1"));
    expect(spy).not.toHaveBeenCalled();
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
