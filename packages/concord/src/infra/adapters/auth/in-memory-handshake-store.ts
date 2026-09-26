import type { HandshakeStore, StoredHandshake } from "../../../domain/ports/out/handshake-store";
import { HandshakeExpiredError } from "../../../domain/exceptions/errors";

const SWEEP_INTERVAL_MS = 1000;

interface Entry {
  readonly payload: StoredHandshake;
  readonly expiresAt: number;
}

export class InMemoryHandshakeStore implements HandshakeStore {
  private readonly entries: Map<string, Entry> = new Map();
  private nextSweepAt: number;

  public constructor(private readonly ttlMs: number) {
    this.nextSweepAt = Date.now() + SWEEP_INTERVAL_MS;
  }

  public async put(id: string, payload: StoredHandshake): Promise<void> {
    this.maybeSweep();
    this.entries.set(id, { payload, expiresAt: Date.now() + this.ttlMs });
  }

  public async take(id: string): Promise<StoredHandshake> {
    this.maybeSweep();
    const entry = this.entries.get(id);
    if (entry === undefined) {
      throw new HandshakeExpiredError(id);
    }
    this.entries.delete(id);
    if (entry.expiresAt <= Date.now()) {
      throw new HandshakeExpiredError(id);
    }
    return entry.payload;
  }

  private maybeSweep(): void {
    const now = Date.now();
    if (now < this.nextSweepAt) {
      return;
    }
    this.nextSweepAt = now + SWEEP_INTERVAL_MS;
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(id);
      }
    }
  }
}
