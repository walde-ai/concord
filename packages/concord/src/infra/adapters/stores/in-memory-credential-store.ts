import type { CredentialStore } from "../../../domain/ports/out/credential-store";
import type { Credential } from "../../../domain/entities/credential";
import type { Result } from "../../../domain/result";
import { success } from "../../../domain/result";
import type { ConcordError } from "../../../domain/exceptions/errors";
import { UserNotFoundError } from "../../../domain/exceptions/errors";

export class InMemoryCredentialStore implements CredentialStore {
  private readonly credentials: Map<string, Credential> = new Map();

  public async getByName(username: string): Promise<Credential> {
    const credential = this.credentials.get(username);
    if (credential === undefined) {
      throw new UserNotFoundError(username);
    }
    return credential;
  }

  public async exists(username: string): Promise<boolean> {
    return this.credentials.has(username);
  }

  public async save(credential: Credential): Promise<Result<void, ConcordError>> {
    this.credentials.set(credential.username, credential);
    return success(undefined);
  }

  public async delete(username: string): Promise<Result<void, ConcordError>> {
    this.credentials.delete(username);
    return success(undefined);
  }
}
