import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { StreamClient } from "./stream-client";
import type { StreamFrame } from "./types";

interface MockSocket {
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  close: ReturnType<typeof vi.fn>;
}

describe("StreamClient", () => {
  let mockSocket: MockSocket;
  const originalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    vi.useFakeTimers();
    mockSocket = {
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      close: vi.fn(),
    };
    vi.stubGlobal(
      "WebSocket",
      vi.fn().mockImplementation(() => mockSocket),
    );
    vi.stubGlobal("window", {
      location: { protocol: "http:", host: "localhost:5173" },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    globalThis.WebSocket = originalWebSocket;
  });

  it("dispatches a parsed frame to the handler", () => {
    const client = new StreamClient();
    const handler = vi.fn();

    client.connect(handler);

    const frame: StreamFrame = { type: "event.created", data: { id: "evt-1" } };
    mockSocket.onmessage!({ data: JSON.stringify(frame) });

    expect(handler).toHaveBeenCalledWith(frame);
  });

  it("attempts reconnection after a close with exponential backoff", () => {
    const client = new StreamClient();
    client.connect(vi.fn());

    expect(mockSocket.onclose).not.toBeNull();
    mockSocket.onclose!();

    const newMock: MockSocket = {
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      close: vi.fn(),
    };
    mockSocket = newMock;
    vi.mocked(globalThis.WebSocket).mockImplementation(() => newMock as unknown as WebSocket);

    vi.advanceTimersByTime(1000);

    expect(vi.mocked(globalThis.WebSocket)).toHaveBeenCalledTimes(2);
  });
});
