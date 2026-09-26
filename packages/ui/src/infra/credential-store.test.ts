import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readStoredCredential, writeStoredCredential, clearStoredCredential } from "./credential-store";

const ORIGINAL_LOCAL_STORAGE = globalThis.localStorage;

function makeMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length(): number {
      return store.size;
    },
    clear(): void {
      store.clear();
    },
    getItem(key: string): string | null {
      return store.has(key) ? (store.get(key) as string) : null;
    },
    key(index: number): string | null {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string): void {
      store.delete(key);
    },
    setItem(key: string, value: string): void {
      store.set(key, value);
    },
  };
}

describe("credential-store", () => {
  let memory: Storage;

  beforeEach(() => {
    memory = makeMemoryStorage();
    vi.stubGlobal("localStorage", memory);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    globalThis.localStorage = ORIGINAL_LOCAL_STORAGE;
  });

  it("returns null when nothing is stored", () => {
    expect(readStoredCredential()).toBeNull();
  });

  it("round-trips username, salt, and privateKey", () => {
    writeStoredCredential("alice", "salt-hex", "private-key-hex");

    const stored = readStoredCredential();

    expect(stored).not.toBeNull();
    expect(stored?.apiVersion).toBe("2026-07-04");
    expect(stored?.username).toBe("alice");
    expect(stored?.salt).toBe("salt-hex");
    expect(stored?.privateKey).toBe("private-key-hex");
  });

  it("clears the stored credential", () => {
    writeStoredCredential("alice", "salt", "key");

    clearStoredCredential();

    expect(readStoredCredential()).toBeNull();
  });

  it("returns null when the stored JSON is corrupt", () => {
    memory.setItem("concord.credentials", "{not json");

    expect(readStoredCredential()).toBeNull();
  });

  it("returns null when the apiVersion does not match", () => {
    memory.setItem(
      "concord.credentials",
      JSON.stringify({
        apiVersion: "1999-01-01",
        username: "alice",
        salt: "salt",
        privateKey: "key",
      }),
    );

    expect(readStoredCredential()).toBeNull();
  });

  it("returns null when any field has the wrong type", () => {
    memory.setItem(
      "concord.credentials",
      JSON.stringify({
        apiVersion: "2026-07-04",
        username: 123,
        salt: "salt",
        privateKey: "key",
      }),
    );

    expect(readStoredCredential()).toBeNull();
  });
});
