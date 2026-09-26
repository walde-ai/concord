import { buildCanonical } from "./canonical";
import { requireSession } from "./session-holder";

function randomNonce(): string {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const parts: string[] = [];
  for (const byte of bytes) {
    parts.push(byte.toString(16).padStart(2, "0"));
  }
  return parts.join("");
}

async function hmacSha256Base64(key: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message));
  const bytes = new Uint8Array(signature);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export interface SignedValues {
  readonly timestamp: string;
  readonly nonce: string;
  readonly signature: string;
}

export async function signRequest(
  method: string,
  path: string,
  body: string,
): Promise<{ headers: Record<string, string>; values: SignedValues }> {
  const session = requireSession();
  const timestamp = String(Date.now());
  const nonce = randomNonce();
  const canonical = await buildCanonical({ method, path, timestamp, nonce, body });
  const signature = await hmacSha256Base64(session.sessionKey, canonical);
  const headers: Record<string, string> = {
    "X-Concord-Session": session.sessionId,
    "X-Concord-Timestamp": timestamp,
    "X-Concord-Nonce": nonce,
    "X-Concord-Signature": signature,
  };
  return { headers, values: { timestamp, nonce, signature } };
}

export async function signStreamUpgrade(): Promise<Record<string, string>> {
  const session = requireSession();
  const values = await signRequestValues("GET", "/api/stream", "");
  return {
    session: session.sessionId,
    timestamp: values.timestamp,
    nonce: values.nonce,
    signature: values.signature,
  };
}

async function signRequestValues(method: string, path: string, body: string): Promise<SignedValues> {
  const session = requireSession();
  const timestamp = String(Date.now());
  const nonce = randomNonce();
  const canonical = await buildCanonical({ method, path, timestamp, nonce, body });
  const signature = await hmacSha256Base64(session.sessionKey, canonical);
  return { timestamp, nonce, signature };
}
