import { Credential } from "../../../../../domain/entities/credential";

export class CredentialV1 {
  public static readonly version = "v1";

  public constructor(
    public readonly username: string,
    public readonly salt: string,
    public readonly verifier: string,
  ) {}

  public toDomain(): Credential {
    return new Credential(this.username, this.salt, this.verifier);
  }

  public static fromDomain(credential: Credential): CredentialV1 {
    return new CredentialV1(credential.username, credential.salt, credential.verifier);
  }
}
