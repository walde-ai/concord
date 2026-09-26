import { defineStore } from "pinia";
import { ref, computed } from "vue";
import {
  srpLogin,
  srpRelogin,
  LoginError,
  type LoginSession,
  type StoredCredential,
} from "../infra/srp-login";
import {
  setSession,
  setRefreshHandler,
  setInvalidHandler,
} from "../infra/session-holder";
import {
  readStoredCredential,
  writeStoredCredential,
  clearStoredCredential,
} from "../infra/credential-store";

const SESSION_STORAGE_KEY = "concord.session";
const SESSION_API_VERSION = "2026-07-11";

interface PersistedSession {
  readonly apiVersion: string;
  readonly sessionId: string;
  readonly username: string;
  readonly sessionKey: string;
}

function isValidPersistedSession(value: unknown): value is PersistedSession {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const candidate = value as PersistedSession;
  if (candidate.apiVersion !== SESSION_API_VERSION) {
    return false;
  }
  return typeof candidate.sessionId === "string" && typeof candidate.username === "string" && typeof candidate.sessionKey === "string";
}

function readPersistedSession(): LoginSession | null {
  try {
    const raw = localStorage.getItem(SESSION_STORAGE_KEY);
    if (raw === null) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!isValidPersistedSession(parsed)) {
      return null;
    }
    return { sessionId: parsed.sessionId, username: parsed.username, sessionKey: parsed.sessionKey };
  } catch {
    return null;
  }
}

function writePersistedSession(session: LoginSession | null): void {
  try {
    if (session === null) {
      localStorage.removeItem(SESSION_STORAGE_KEY);
    } else {
      const value: PersistedSession = {
        apiVersion: SESSION_API_VERSION,
        sessionId: session.sessionId,
        username: session.username,
        sessionKey: session.sessionKey,
      };
      localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(value));
    }
  } catch {
    // localStorage unavailable; carry on with in-memory session only
  }
}

export const useAuthStore = defineStore("auth", () => {
  const restoredSession = readPersistedSession();
  if (restoredSession !== null) {
    setSession(restoredSession);
  }

  const session = ref<LoginSession | null>(restoredSession);
  const authenticating = ref(false);
  const loginError = ref<string | null>(null);
  const sessionInvalid = ref(false);

  const isAuthenticated = computed(() => session.value !== null);

  function installSession(next: LoginSession): void {
    session.value = next;
    setSession(next);
    writePersistedSession(next);
  }

  function clearSession(): void {
    session.value = null;
    setSession(null);
    writePersistedSession(null);
  }

  async function reauthenticate(stored: StoredCredential): Promise<boolean> {
    try {
      const fresh = await srpRelogin(stored);
      installSession(fresh);
      return true;
    } catch {
      clearStoredCredential();
      clearSession();
      return false;
    }
  }

  setRefreshHandler(async () => {
    const stored = readStoredCredential();
    if (stored === null) {
      return false;
    }
    return reauthenticate(stored);
  });

  setInvalidHandler(() => {
    clearSession();
    sessionInvalid.value = true;
  });

  async function login(username: string, password: string): Promise<boolean> {
    authenticating.value = true;
    loginError.value = null;
    sessionInvalid.value = false;
    try {
      const result = await srpLogin(username, password);
      installSession(result.session);
      writeStoredCredential(result.credential.username, result.credential.salt, result.credential.privateKey);
      return true;
    } catch (cause) {
      clearSession();
      clearStoredCredential();
      loginError.value =
        cause instanceof LoginError
          ? cause.message
          : cause instanceof Error
            ? cause.message
            : String(cause);
      return false;
    } finally {
      authenticating.value = false;
    }
  }

  function logout(): void {
    clearSession();
    clearStoredCredential();
    sessionInvalid.value = false;
  }

  function acknowledgeSessionInvalid(): void {
    sessionInvalid.value = false;
  }

  return {
    session,
    authenticating,
    loginError,
    sessionInvalid,
    isAuthenticated,
    login,
    logout,
    acknowledgeSessionInvalid,
  };
});
