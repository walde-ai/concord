import type { NonceCache } from "../../../domain/ports/out/nonce-cache";

interface Entry {
  readonly nonce: string;
  readonly timestamp: number;
}

const SWEEP_INTERVAL_MS = 1000;

export class InMemoryNonceCache implements NonceCache {
  private readonly entries: Map<string, Entry> = new Map();
  private nextSweepAt: number;

  public constructor(private readonly freshnessWindowMs: number) {
    this.nextSweepAt = Date.now() + SWEEP_INTERVAL_MS;
  }

  public async saw(nonce: string, timestamp: number): Promise<boolean> {
    this.maybeSweep();
    const alreadyPresent = this.entries.has(nonce);
    if (alreadyPresent) {
      return true;
    }
    this.entries.set(nonce, { nonce, timestamp });
    return false;
  }

  private maybeSweep(): void {
    const now = Date.now();
    if (now < this.nextSweepAt) {
      return;
    }
    this.nextSweepAt = now + SWEEP_INTERVAL_MS;
    const cutoff = now - this.freshnessWindowMs;
    for (const [nonce, entry] of this.entries) {
      if (entry.timestamp < cutoff) {
        this.entries.delete(nonce);
      }
    }
  }
}
