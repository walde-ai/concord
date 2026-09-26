import type { CreateUser } from "../ports/in/create-user";
import type { CredentialStore } from "../ports/out/credential-store";
import type { CredentialIssuer } from "../ports/out/credential-issuer";
import type { UserDescriptor } from "../user-descriptor";
import { Credential } from "../entities/credential";
import { UserAlreadyExistsError } from "../exceptions/errors";

export class CreateUserInteractor implements CreateUser {
  public constructor(
    private readonly store: CredentialStore,
    private readonly issuer: CredentialIssuer,
  ) {}

  public async create(username: string, password: string): Promise<UserDescriptor> {
    if (await this.store.exists(username)) {
      throw new UserAlreadyExistsError(username);
    }
    const issued = await this.issuer.generate(username, password);
    const credential = new Credential(username, issued.salt, issued.verifier);
    await this.store.save(credential);
    return { username };
  }
}
