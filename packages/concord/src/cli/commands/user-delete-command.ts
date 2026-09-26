import { DeleteUserInteractor } from "../../domain/interactors/delete-user-interactor";
import type { UserCommandDeps } from "../main/compose";

export interface UserDeleteInput {
  readonly name: string;
  readonly deps: UserCommandDeps;
}

export async function userDeleteCommand(input: UserDeleteInput): Promise<{ username: string }> {
  const del = new DeleteUserInteractor(input.deps.bundle.credentialStore);
  await del.delete(input.name);
  await input.deps.bundle.database.close();
  return { username: input.name };
}
