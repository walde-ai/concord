import type { Credential } from "../../entities/credential";

export interface SrpHandshakeBeginResult {
  readonly serverSecret: string;
  readonly serverPublicEphemeral: string;
}

export interface SrpHandshakeCompleteResult {
  readonly sessionKey: string;
  readonly serverSessionProof: string;
}

export interface SrpFakeBeginResult {
  readonly salt: string;
  readonly serverPublicEphemeral: string;
}

export interface SrpHandshake {
  begin(clientPublicEphemeral: string, credential: Credential): Promise<SrpHandshakeBeginResult>;
  complete(
    serverSecret: string,
    clientPublicEphemeral: string,
    credential: Credential,
    clientSessionProof: string,
  ): Promise<SrpHandshakeCompleteResult>;
  beginFake(username: string, clientPublicEphemeral: string): Promise<SrpFakeBeginResult>;
}
