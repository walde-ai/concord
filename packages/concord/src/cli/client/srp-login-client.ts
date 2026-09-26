import * as srpClient from "secure-remote-password/client";
import type { Argon2PasswordSecretDeriver } from "../../infra/adapters/auth/argon2-password-secret-deriver";

export interface LoginSession {
  readonly sessionId: string;
  readonly sessionKey: string;
}

export interface SrpLoginClient {
  login(origin: string, username: string, password: string): Promise<LoginSession>;
}

export function createSrpLoginClient(deriver: Argon2PasswordSecretDeriver): SrpLoginClient {
  return {
    async login(origin: string, username: string, password: string): Promise<LoginSession> {
      const clientEphemeral = srpClient.generateEphemeral();

      const initResponse = await fetch(`${origin}/api/auth/init`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, clientPublicEphemeral: clientEphemeral.public }),
      });
      const initBody = (await initResponse.json()) as {
        ok: boolean;
        data?: { salt: string; serverPublicEphemeral: string; handshakeId: string };
        error?: { code: string; message: string };
      };
      if (!initBody.ok || initBody.data === undefined) {
        throw new Error(`login init failed: ${initBody.error?.message ?? "unknown error"}`);
      }

      const digest = await deriver.derive(password, initBody.data.salt);
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
        data?: { sessionId: string; serverSessionProof: string };
        error?: { code: string; message: string };
      };
      if (!verifyBody.ok || verifyBody.data === undefined) {
        throw new Error(`login verify failed: ${verifyBody.error?.message ?? "invalid credentials"}`);
      }

      return {
        sessionId: verifyBody.data.sessionId,
        sessionKey: clientSession.key,
      };
    },
  };
}
