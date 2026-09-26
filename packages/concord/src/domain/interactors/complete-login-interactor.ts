import type { CompleteLogin, CompleteLoginResult } from "../ports/in/complete-login";
import type { HandshakeStore } from "../ports/out/handshake-store";
import type { CredentialStore } from "../ports/out/credential-store";
import type { SrpHandshake } from "../ports/out/srp-handshake";
import type { SessionStore } from "../ports/out/session-store";
import type { IdGenerator } from "../ports/out/id-generator";
import type { Clock } from "../ports/out/clock";
import { InvalidProofError } from "../exceptions/errors";

export class CompleteLoginInteractor implements CompleteLogin {
  public constructor(
    private readonly handshakeStore: HandshakeStore,
    private readonly store: CredentialStore,
    private readonly handshake: SrpHandshake,
    private readonly sessionStore: SessionStore,
    private readonly idGenerator: IdGenerator,
    private readonly clock: Clock,
    private readonly sessionLifetimeMs: number,
  ) {}

  public async complete(
    handshakeId: string,
    clientPublicEphemeral: string,
    clientSessionProof: string,
  ): Promise<CompleteLoginResult> {
    const stored = await this.handshakeStore.take(handshakeId);

    if (stored.clientPublicEphemeral !== clientPublicEphemeral) {
      throw new InvalidProofError();
    }

    if (stored.fake) {
      throw new InvalidProofError();
    }

    const credential = await this.store.getByName(stored.username);
    const completed = await this.handshake.complete(
      stored.serverSecret,
      clientPublicEphemeral,
      credential,
      clientSessionProof,
    );

    const expiresAt = new Date(this.clock.now().getTime() + this.sessionLifetimeMs);
    const sessionId = await this.sessionStore.create({
      username: stored.username,
      sessionKey: completed.sessionKey,
      expiresAt,
    });

    return {
      sessionId,
      username: stored.username,
      serverSessionProof: completed.serverSessionProof,
    };
  }
}
