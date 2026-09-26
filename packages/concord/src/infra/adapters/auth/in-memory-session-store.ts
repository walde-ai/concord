import { randomBytes } from "node:crypto";
import type { SessionStore, SessionValue } from "../../../domain/ports/out/session-store";
import { SessionExpiredError } from "../../../domain/exceptions/errors";

interface StoredSession extends SessionValue {
  expiresAt: Date;
}

export class InMemorySessionStore implements SessionStore {
  private readonly sessions: Map<string, StoredSession> = new Map();

  public async create(value: SessionValue): Promise<string> {
    const id = randomBytes(32).toString("hex");
    this.sessions.set(id, {
      username: value.username,
      sessionKey: value.sessionKey,
      expiresAt: value.expiresAt,
    });
    return id;
  }

  public async get(id: string): Promise<SessionValue> {
    const session = this.sessions.get(id);
    if (session === undefined) {
      throw new SessionExpiredError(id);
    }
    if (session.expiresAt.getTime() <= Date.now()) {
      this.sessions.delete(id);
      throw new SessionExpiredError(id);
    }
    return {
      username: session.username,
      sessionKey: session.sessionKey,
      expiresAt: session.expiresAt,
    };
  }

  public async touch(id: string, expiresAt: Date): Promise<void> {
    const session = this.sessions.get(id);
    if (session === undefined) {
      return;
    }
    session.expiresAt = expiresAt;
  }
}
