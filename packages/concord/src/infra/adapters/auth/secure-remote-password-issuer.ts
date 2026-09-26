import { generateSalt, derivePrivateKey, deriveVerifier } from "secure-remote-password/client";
import type { CredentialIssuer, IssuedCredential } from "../../../domain/ports/out/credential-issuer";
import type { PasswordSecretDeriver } from "../../../domain/ports/out/password-secret-deriver";
import { randomBytes } from "node:crypto";

export class SecureRemotePasswordIssuer implements CredentialIssuer {
  public constructor(private readonly deriver: PasswordSecretDeriver) {}

  public async generate(username: string, password: string): Promise<IssuedCredential> {
    const salt = this.generateSaltHex();
    const digest = await this.deriver.derive(password, salt);
    const privateKey = derivePrivateKey(salt, username, digest);
    const verifier = deriveVerifier(privateKey);
    return { salt, verifier };
  }

  private generateSaltHex(): string {
    return randomBytes(16).toString("hex");
  }
}

export { generateSalt };
