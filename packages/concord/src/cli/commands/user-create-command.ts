import { CreateUserInteractor } from "../../domain/interactors/create-user-interactor";
import type { UserDescriptor } from "../../domain/user-descriptor";
import type { UserCommandDeps } from "../main/compose";

export interface UserCreateInput {
  readonly name: string;
  readonly password: string;
  readonly deps: UserCommandDeps;
}

export async function userCreateCommand(input: UserCreateInput): Promise<UserDescriptor> {
  const create = new CreateUserInteractor(input.deps.bundle.credentialStore, input.deps.issuer);
  const descriptor = await create.create(input.name, input.password);
  await input.deps.bundle.database.close();
  return descriptor;
}
