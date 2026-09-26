import * as srp from "secure-remote-password/client";
import { derivePasswordDigest } from "./argon2-deriver";

export interface LoginSession {
  readonly sessionId: string;
  readonly username: string;
  readonly sessionKey: string;
}

export interface StoredCredential {
  readonly username: string;
  readonly salt: string;
  readonly privateKey: string;
}

export interface LoginResult {
  readonly session: LoginSession;
  readonly credential: StoredCredential;
}

export class LoginError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "LoginError";
  }
}

interface InitResponse {
  readonly salt: string;
  readonly serverPublicEphemeral: string;
  readonly handshakeId: string;
}

interface VerifyResponse {
  readonly sessionId: string;
  readonly username: string;
  readonly serverSessionProof: string;
}

async function postInit(username: string, clientPublicEphemeral: string): Promise<InitResponse> {
  const response = await fetch("/api/auth/init", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, clientPublicEphemeral }),
  });
  const body = (await response.json()) as {
    ok: boolean;
    data?: InitResponse;
    error?: { message: string };
  };
  if (!body.ok || body.data === undefined) {
    throw new LoginError(body.error?.message ?? "login init failed");
  }
  return body.data;
}

async function postVerify(
  handshakeId: string,
  clientPublicEphemeral: string,
  clientSessionProof: string,
): Promise<VerifyResponse> {
  const response = await fetch("/api/auth/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      handshakeId,
      clientPublicEphemeral,
      clientSessionProof,
    }),
  });
  const body = (await response.json()) as {
    ok: boolean;
    data?: VerifyResponse;
    error?: { message: string };
  };
  if (!body.ok || body.data === undefined) {
    throw new LoginError(body.error?.message ?? "invalid credentials");
  }
  return body.data;
}

interface ClientEphemeral {
  readonly public: string;
  readonly secret: string;
}

async function finishHandshake(
  username: string,
  salt: string,
  privateKey: string,
  clientEphemeral: ClientEphemeral,
  init: InitResponse,
): Promise<LoginSession> {
  const clientSession = srp.deriveSession(
    clientEphemeral.secret,
    init.serverPublicEphemeral,
    salt,
    username,
    privateKey,
  );
  const verify = await postVerify(init.handshakeId, clientEphemeral.public, clientSession.proof);
  srp.verifySession(clientEphemeral.public, clientSession, verify.serverSessionProof);
  return { sessionId: verify.sessionId, username: verify.username, sessionKey: clientSession.key };
}

export async function srpLogin(username: string, password: string): Promise<LoginResult> {
  const clientEphemeral = srp.generateEphemeral();
  const init = await postInit(username, clientEphemeral.public);
  const digest = await derivePasswordDigest(password, init.salt);
  const privateKey = srp.derivePrivateKey(init.salt, username, digest);
  const session = await finishHandshake(username, init.salt, privateKey, clientEphemeral, init);
  return {
    session,
    credential: { username, salt: init.salt, privateKey },
  };
}

export async function srpRelogin(credential: StoredCredential): Promise<LoginSession> {
  const clientEphemeral = srp.generateEphemeral();
  const init = await postInit(credential.username, clientEphemeral.public);
  if (init.salt !== credential.salt) {
    throw new LoginError("stored credential no longer matches server");
  }
  return finishHandshake(
    credential.username,
    credential.salt,
    credential.privateKey,
    clientEphemeral,
    init,
  );
}
