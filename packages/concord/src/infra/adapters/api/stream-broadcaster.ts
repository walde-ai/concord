import { WebSocket } from "ws";
import type { Event } from "../../../domain/entities/event";
import type { Run } from "../../../domain/entities/run";
import type { PeakHours } from "../../../domain/peak-hours";
import type { EventLifecycleObserver } from "../../../domain/ports/out/event-lifecycle-observer";
import type { RunActivityEmitter, RunActivityFrame } from "../opencode/run-activity-emitter";
import {
  toEventDto,
  toRunDto,
  toPeakHoursDto,
  type ApiErrorBody,
} from "./api-dtos";

interface LifecycleFrame<T> {
  readonly type: string;
  readonly data: T;
}

interface ClientMessage {
  readonly type: string;
  readonly runId?: unknown;
}

export class StreamBroadcaster implements EventLifecycleObserver, RunActivityEmitter {
  private readonly clients: Set<WebSocket> = new Set();
  // Per-run subscribers for activity frames. Lifecycle frames still fan out to
  // every connected client; only run.activity is routed per run, driven by
  // subscribe/unsubscribe messages the UI sends when it opens a run's Activity
  // section. A run with no subscribers has its activity dropped (a no-op emit).
  private readonly runSubscribers: Map<string, Set<WebSocket>> = new Map();

  public addClient(socket: WebSocket): void {
    this.clients.add(socket);
    socket.on("message", (raw: unknown) => this.handleClientMessage(socket, raw));
    socket.on("close", () => {
      this.removeSocketEverywhere(socket);
    });
    socket.on("error", () => {
      this.removeSocketEverywhere(socket);
    });
  }

  public eventCreated(event: Event<unknown>): void {
    this.broadcast<LifecycleFrame<ReturnType<typeof toEventDto>>>({
      type: "event.created",
      data: toEventDto(event),
    });
  }

  public runCreated(run: Run<unknown>): void {
    this.broadcast<LifecycleFrame<ReturnType<typeof toRunDto>>>({
      type: "run.created",
      data: toRunDto(run),
    });
  }

  public runStateChanged(run: Run<unknown>): void {
    this.broadcast<LifecycleFrame<ReturnType<typeof toRunDto>>>({
      type: "run.state_changed",
      data: toRunDto(run),
    });
  }

  public pausedChanged(paused: boolean): void {
    this.broadcast<LifecycleFrame<{ paused: boolean }>>({
      type: "system.paused_changed",
      data: { paused },
    });
  }

  public peakHoursChanged(peakHours: PeakHours | null): void {
    this.broadcast<LifecycleFrame<ReturnType<typeof toPeakHoursDto>>>({
      type: "system.peak_hours_changed",
      data: toPeakHoursDto(peakHours),
    });
  }

  public sendError(error: ApiErrorBody): void {
    this.broadcast<{ type: string; data: ApiErrorBody }>({
      type: "error",
      data: error,
    });
  }

  public emit(frame: RunActivityFrame): void {
    const subscribers = this.runSubscribers.get(frame.runId);
    if (subscribers === undefined) {
      return;
    }
    const text = JSON.stringify({ type: "run.activity", data: frame } as LifecycleFrame<RunActivityFrame>);
    for (const socket of subscribers) {
      if (socket.readyState === WebSocket.OPEN) {
        try {
          socket.send(text);
        } catch {
          this.removeSocketEverywhere(socket);
        }
      }
    }
  }

  public hasClients(): boolean {
    return this.clients.size > 0;
  }

  public hasSubscribers(): boolean {
    return this.hasClients();
  }

  private handleClientMessage(socket: WebSocket, raw: unknown): void {
    const text = typeof raw === "string" ? raw : undefined;
    if (text === undefined) {
      return;
    }
    const message = safeParseClientMessage(text);
    if (message === null) {
      return;
    }
    if (message.type === "subscribe") {
      if (typeof message.runId === "string" && message.runId.length > 0) {
        this.addRunSubscriber(message.runId, socket);
      }
      return;
    }
    if (message.type === "unsubscribe") {
      if (typeof message.runId === "string") {
        this.removeRunSubscriber(message.runId, socket);
      }
      return;
    }
    // Unknown message types are ignored: only subscribe/unsubscribe are defined.
  }

  private addRunSubscriber(runId: string, socket: WebSocket): void {
    const existing = this.runSubscribers.get(runId);
    if (existing === undefined) {
      this.runSubscribers.set(runId, new Set([socket]));
    } else {
      existing.add(socket);
    }
  }

  private removeRunSubscriber(runId: string, socket: WebSocket): void {
    const set = this.runSubscribers.get(runId);
    if (set === undefined) {
      return;
    }
    set.delete(socket);
    if (set.size === 0) {
      this.runSubscribers.delete(runId);
    }
  }

  private removeSocketEverywhere(socket: WebSocket): void {
    this.clients.delete(socket);
    for (const runId of [...this.runSubscribers.keys()]) {
      this.removeRunSubscriber(runId, socket);
    }
  }

  private broadcast<T>(frame: T): void {
    const text = JSON.stringify(frame);
    for (const socket of this.clients) {
      if (socket.readyState === WebSocket.OPEN) {
        try {
          socket.send(text);
        } catch {
          this.removeSocketEverywhere(socket);
        }
      }
    }
  }
}

function safeParseClientMessage(text: string): ClientMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed as { type?: unknown };
  if (typeof obj.type !== "string") {
    return null;
  }
  return parsed as ClientMessage;
}
