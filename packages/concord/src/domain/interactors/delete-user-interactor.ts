import type { DeleteUser } from "../ports/in/delete-user";
import type { CredentialStore } from "../ports/out/credential-store";

export class DeleteUserInteractor implements DeleteUser {
  public constructor(private readonly store: CredentialStore) {}

  public async delete(username: string): Promise<void> {
    await this.store.getByName(username);
    await this.store.delete(username);
  }
}
