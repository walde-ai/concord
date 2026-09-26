import type { LoginSession } from "./srp-login";

let currentSession: LoginSession | null = null;
let refreshHandler: (() => Promise<boolean>) | null = null;
let invalidHandler: (() => void) | null = null;

export function setSession(session: LoginSession | null): void {
  currentSession = session;
}

export function getSession(): LoginSession | null {
  return currentSession;
}

export function requireSession(): LoginSession {
  if (currentSession === null) {
    throw new Error("Not authenticated");
  }
  return currentSession;
}

export function setRefreshHandler(handler: (() => Promise<boolean>) | null): void {
  refreshHandler = handler;
}

export function setInvalidHandler(handler: (() => void) | null): void {
  invalidHandler = handler;
}

export async function refreshSession(): Promise<boolean> {
  if (refreshHandler === null) {
    return false;
  }
  return refreshHandler();
}

export function notifySessionInvalid(): void {
  if (invalidHandler !== null) {
    invalidHandler();
  }
}
