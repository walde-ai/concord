import type { BeginLogin, BeginLoginResult } from "../ports/in/begin-login";
import type { CredentialStore } from "../ports/out/credential-store";
import type { SrpHandshake } from "../ports/out/srp-handshake";
import type { HandshakeStore } from "../ports/out/handshake-store";
import type { StoredHandshake } from "../ports/out/handshake-store";
import type { IdGenerator } from "../ports/out/id-generator";
import type { Credential } from "../entities/credential";

export class BeginLoginInteractor implements BeginLogin {
  public constructor(
    private readonly store: CredentialStore,
    private readonly handshake: SrpHandshake,
    private readonly handshakeStore: HandshakeStore,
    private readonly idGenerator: IdGenerator,
  ) {}

  public async begin(username: string, clientPublicEphemeral: string): Promise<BeginLoginResult> {
    const handshakeId = this.idGenerator.generate();
    const credential = await this.fetchCredential(username);

    if (credential !== null) {
      const begun = await this.handshake.begin(clientPublicEphemeral, credential);
      const payload: StoredHandshake = {
        serverSecret: begun.serverSecret,
        clientPublicEphemeral,
        username,
        fake: false,
      };
      await this.handshakeStore.put(handshakeId, payload);
      return {
        salt: credential.salt,
        serverPublicEphemeral: begun.serverPublicEphemeral,
        handshakeId,
      };
    }

    const fake = await this.handshake.beginFake(username, clientPublicEphemeral);
    const payload: StoredHandshake = {
      serverSecret: "",
      clientPublicEphemeral,
      username,
      fake: true,
    };
    await this.handshakeStore.put(handshakeId, payload);
    return {
      salt: fake.salt,
      serverPublicEphemeral: fake.serverPublicEphemeral,
      handshakeId,
    };
  }

  private async fetchCredential(username: string): Promise<Credential | null> {
    try {
      return await this.store.getByName(username);
    } catch {
      return null;
    }
  }
}
