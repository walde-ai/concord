const STORAGE_KEY = "concord.credentials";
const API_VERSION = "2026-07-04";

export interface StoredCredential {
  readonly apiVersion: string;
  readonly username: string;
  readonly salt: string;
  readonly privateKey: string;
}

function isValidShape(value: unknown): value is StoredCredential {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const candidate = value as StoredCredential;
  if (candidate.apiVersion !== API_VERSION) {
    return false;
  }
  return (
    typeof candidate.username === "string" &&
    typeof candidate.salt === "string" &&
    typeof candidate.privateKey === "string"
  );
}

export function readStoredCredential(): StoredCredential | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!isValidShape(parsed)) {
      return null;
    }
    return {
      apiVersion: parsed.apiVersion,
      username: parsed.username,
      salt: parsed.salt,
      privateKey: parsed.privateKey,
    };
  } catch {
    return null;
  }
}

export function writeStoredCredential(username: string, salt: string, privateKey: string): void {
  try {
    const value: StoredCredential = { apiVersion: API_VERSION, username, salt, privateKey };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // localStorage unavailable (private mode / disabled); carry on without persistence
  }
}

export function clearStoredCredential(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // localStorage unavailable; nothing to clear
  }
}
