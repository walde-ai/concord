import type { StreamFrame } from "./types";
import { signStreamUpgrade } from "./signing";
import { getSession } from "./session-holder";

export type FrameHandler = (frame: StreamFrame) => void;

export class StreamClient {
  private socket: WebSocket | null = null;
  private handler: FrameHandler | null = null;
  private reconnectDelay = 1000;
  private shouldReconnect = true;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  public constructor(private readonly url = "/api/stream") {}

  public connect(handler: FrameHandler): void {
    this.handler = handler;
    this.shouldReconnect = true;
    this.open();
  }

  public disconnect(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket !== null) {
      this.socket.onclose = null;
      this.socket.onerror = null;
      this.socket.onmessage = null;
      this.socket.close();
      this.socket = null;
    }
  }

  public send(message: string): boolean {
    if (this.socket !== null && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(message);
      return true;
    }
    return false;
  }

  private async open(): Promise<void> {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const base = `${protocol}//${window.location.host}${this.url}`;
    let fullUrl = base;
    if (getSession() !== null) {
      try {
        const params = await signStreamUpgrade();
        const search = new URLSearchParams(params);
        fullUrl = `${base}?${search.toString()}`;
      } catch {
        fullUrl = base;
      }
    }
    this.socket = new WebSocket(fullUrl);

    this.socket.onopen = () => {
      this.reconnectDelay = 1000;
    };

    this.socket.onmessage = (event: MessageEvent) => {
      if (this.handler !== null) {
        const frame = JSON.parse(event.data as string) as StreamFrame;
        this.handler(frame);
      }
    };

    this.socket.onclose = () => {
      this.socket = null;
      this.scheduleReconnect();
    };

    this.socket.onerror = () => {
      if (this.socket !== null) {
        this.socket.close();
      }
    };
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      void this.open();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
  }
}
