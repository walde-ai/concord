import type { AuthenticateRequest } from "../ports/in/authenticate-request";
import type { SessionStore } from "../ports/out/session-store";
import type { SignatureVerifier } from "../ports/out/signature-verifier";
import type { NonceCache } from "../ports/out/nonce-cache";
import type { Clock } from "../ports/out/clock";
import type { SignedRequest } from "../ports/out/signed-request";
import type { CanonicalRequestBuilder } from "../ports/out/canonical-request";
import {
  InvalidSignatureError,
  ReplayDetectedError,
  SessionExpiredError,
  StaleRequestError,
} from "../exceptions/errors";

export class AuthenticateRequestInteractor implements AuthenticateRequest {
  public constructor(
    private readonly sessionStore: SessionStore,
    private readonly signatureVerifier: SignatureVerifier,
    private readonly nonceCache: NonceCache,
    private readonly clock: Clock,
    private readonly canonical: CanonicalRequestBuilder,
    private readonly freshnessWindowMs: number,
  ) {}

  public async authenticate(request: SignedRequest): Promise<string> {
    const session = await this.fetchSession(request.session);
    const timestamp = this.parseTimestamp(request.timestamp);
    const now = this.clock.now().getTime();
    if (Math.abs(now - timestamp) > this.freshnessWindowMs) {
      throw new StaleRequestError();
    }
    const alreadySeen = await this.nonceCache.saw(request.nonce, timestamp);
    if (alreadySeen) {
      throw new ReplayDetectedError(request.nonce);
    }
    const message = this.canonical.build({
      method: request.method,
      path: request.path,
      timestamp: request.timestamp,
      nonce: request.nonce,
      body: request.body,
    });
    const valid = this.signatureVerifier.verify(session.sessionKey, message, request.signature);
    if (!valid) {
      throw new InvalidSignatureError();
    }
    const refreshed = new Date(now + this.freshnessWindowMs);
    await this.sessionStore.touch(request.session, refreshed);
    return session.username;
  }

  private async fetchSession(sessionId: string) {
    try {
      return await this.sessionStore.get(sessionId);
    } catch {
      throw new SessionExpiredError(sessionId);
    }
  }

  private parseTimestamp(timestamp: string): number {
    const parsed = Number(timestamp);
    if (!Number.isFinite(parsed)) {
      throw new StaleRequestError();
    }
    return parsed;
  }
}
