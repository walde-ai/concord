import { generateEphemeral, deriveSession } from "secure-remote-password/server";
import { createHmac } from "node:crypto";
import type { Credential } from "../../../domain/entities/credential";
import type {
  SrpHandshake,
  SrpHandshakeBeginResult,
  SrpHandshakeCompleteResult,
  SrpFakeBeginResult,
} from "../../../domain/ports/out/srp-handshake";
import { InvalidProofError } from "../../../domain/exceptions/errors";

const FAKE_SALT_BYTES = 16;
const EPHEMERAL_HEX_LENGTH = 512;

export class SecureRemotePasswordHandshake implements SrpHandshake {
  public constructor(private readonly pepper: string) {}

  public async begin(
    clientPublicEphemeral: string,
    credential: Credential,
  ): Promise<SrpHandshakeBeginResult> {
    const ephemeral = generateEphemeral(credential.verifier);
    return {
      serverSecret: ephemeral.secret,
      serverPublicEphemeral: ephemeral.public,
    };
  }

  public async complete(
    serverSecret: string,
    clientPublicEphemeral: string,
    credential: Credential,
    clientSessionProof: string,
  ): Promise<SrpHandshakeCompleteResult> {
    try {
      const session = deriveSession(
        serverSecret,
        clientPublicEphemeral,
        credential.salt,
        credential.username,
        credential.verifier,
        clientSessionProof,
      );
      return {
        sessionKey: session.key,
        serverSessionProof: session.proof,
      };
    } catch {
      throw new InvalidProofError();
    }
  }

  public async beginFake(username: string, _clientPublicEphemeral: string): Promise<SrpFakeBeginResult> {
    const salt = this.deriveFakeHex(username, "salt", FAKE_SALT_BYTES * 2);
    const serverPublicEphemeral = this.deriveFakeHex(username, "ephemeral", EPHEMERAL_HEX_LENGTH);
    return { salt, serverPublicEphemeral };
  }

  private deriveFakeHex(username: string, label: string, hexLength: number): string {
    const segments: string[] = [];
    let counter = 0;
    while (this.joinedLength(segments) < hexLength) {
      const data = `${label}:${counter}:${username}`;
      segments.push(this.hmac(data));
      counter += 1;
    }
    return segments.join("").slice(0, hexLength);
  }

  private joinedLength(segments: string[]): number {
    return segments.reduce((sum, segment) => sum + segment.length, 0);
  }

  private hmac(data: string): string {
    return createHmac("sha256", this.pepper).update(data).digest("hex");
  }
}
