import { createHmac, randomUUID } from "node:crypto";
import { CanonicalRequest } from "../../infra/adapters/auth/canonical-request";
import type { ContextDto, EventDto } from "../../infra/adapters/api/api-dtos";
import type { LoginSession } from "./srp-login-client";

export interface SignedApiPostResult<T> {
  readonly status: number;
  readonly body: T;
}

export interface SignedApiPutResult<T> {
  readonly status: number;
  readonly body: T;
}

export interface SecretPairInput {
  readonly name: string;
  readonly value: string;
}

export function buildSignedHeaders(
  session: LoginSession,
  method: string,
  path: string,
  body: string,
): Record<string, string> {
  const canonical = new CanonicalRequest();
  const timestamp = String(Date.now());
  const nonce = randomUUID();
  const message = canonical.build({ method, path, timestamp, nonce, body });
  const signature = createHmac("sha256", session.sessionKey).update(message).digest("base64");
  return {
    "X-Concord-Session": session.sessionId,
    "X-Concord-Timestamp": timestamp,
    "X-Concord-Nonce": nonce,
    "X-Concord-Signature": signature,
    "Content-Type": "application/json",
  };
}

export async function signedPostEvent(
  origin: string,
  session: LoginSession,
  body: { type: string; payload: unknown; producerId: string },
): Promise<SignedApiPostResult<EventDto>> {
  const path = "/api/events";
  const bodyText = JSON.stringify(body);
  const headers = buildSignedHeaders(session, "POST", path, bodyText);
  const response = await fetch(`${origin}${path}`, { method: "POST", headers, body: bodyText });
  const parsed = (await response.json()) as EventDto & { ok?: boolean; error?: { code: string; message: string } };
  return { status: response.status, body: parsed };
}

export async function signedCreateContext(
  origin: string,
  session: LoginSession,
  body: { name: string; payload: unknown; secrets: readonly SecretPairInput[] },
): Promise<SignedApiPostResult<ContextEnvelope>> {
  const path = "/api/contexts";
  const bodyText = JSON.stringify(body);
  const headers = buildSignedHeaders(session, "POST", path, bodyText);
  const response = await fetch(`${origin}${path}`, { method: "POST", headers, body: bodyText });
  const parsed = (await response.json()) as ContextEnvelope;
  return { status: response.status, body: parsed };
}

export async function signedUpdateContext(
  origin: string,
  session: LoginSession,
  name: string,
  body: { payload: unknown; secrets: { upserts: readonly SecretPairInput[]; deletes: readonly string[] } },
): Promise<SignedApiPutResult<ContextEnvelope>> {
  const path = `/api/contexts/${encodeURIComponent(name)}`;
  const bodyText = JSON.stringify(body);
  const headers = buildSignedHeaders(session, "PUT", path, bodyText);
  const response = await fetch(`${origin}${path}`, { method: "PUT", headers, body: bodyText });
  const parsed = (await response.json()) as ContextEnvelope;
  return { status: response.status, body: parsed };
}

export interface ContextEnvelope {
  readonly ok?: boolean;
  readonly data?: ContextDto;
  readonly error?: { code: string; message: string };
}
