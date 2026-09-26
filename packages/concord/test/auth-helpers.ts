import * as srpClient from "secure-remote-password/client";
import { randomUUID, createHmac } from "node:crypto";

import { TEST_ARGON2ID_PARAMETERS } from "../src";
import { Argon2PasswordSecretDeriver } from "../src";
import { CanonicalRequest } from "../src/infra/adapters/auth/canonical-request";

export interface LoginSession {
  readonly sessionId: string;
  readonly sessionKey: string;
}

const DERIVER = new Argon2PasswordSecretDeriver(TEST_ARGON2ID_PARAMETERS);
const CANONICAL = new CanonicalRequest();

export async function buildLoginSession(
  baseUrl: string,
  username: string,
  password: string,
): Promise<LoginSession> {
  const origin = baseUrl.startsWith("http") ? baseUrl : `http://${baseUrl}`;
  const clientEphemeral = srpClient.generateEphemeral();

  const initResponse = await fetch(`${origin}/api/auth/init`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, clientPublicEphemeral: clientEphemeral.public }),
  });
  const initBody = (await initResponse.json()) as {
    ok: boolean;
    data: { salt: string; serverPublicEphemeral: string; handshakeId: string };
  };
  if (!initBody.ok) {
    throw new Error(`login init failed: ${JSON.stringify(initBody)}`);
  }

  const digest = await DERIVER.derive(password, initBody.data.salt);
  const privateKey = srpClient.derivePrivateKey(initBody.data.salt, username, digest);
  const clientSession = srpClient.deriveSession(
    clientEphemeral.secret,
    initBody.data.serverPublicEphemeral,
    initBody.data.salt,
    username,
    privateKey,
  );

  const verifyResponse = await fetch(`${origin}/api/auth/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      handshakeId: initBody.data.handshakeId,
      clientPublicEphemeral: clientEphemeral.public,
      clientSessionProof: clientSession.proof,
    }),
  });
  const verifyBody = (await verifyResponse.json()) as {
    ok: boolean;
    data: { sessionId: string; serverSessionProof: string };
  };
  if (!verifyBody.ok) {
    throw new Error(`login verify failed: ${JSON.stringify(verifyBody)}`);
  }

  srpClient.verifySession(clientEphemeral.public, clientSession, verifyBody.data.serverSessionProof);

  return { sessionId: verifyBody.data.sessionId, sessionKey: clientSession.key };
}

export function signHeaders(
  session: LoginSession,
  method: string,
  path: string,
  body: string,
): Record<string, string> {
  const timestamp = String(Date.now());
  const nonce = randomUUID();
  const canonical = CANONICAL.build({ method, path, timestamp, nonce, body });
  const signature = createHmac("sha256", session.sessionKey).update(canonical).digest("base64");
  return {
    "X-Concord-Session": session.sessionId,
    "X-Concord-Timestamp": timestamp,
    "X-Concord-Nonce": nonce,
    "X-Concord-Signature": signature,
  };
}

export { srpClient, Argon2PasswordSecretDeriver, CanonicalRequest };
