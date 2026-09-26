import type { CreateContext } from "../ports/in/create-context";
import type { ContextStore } from "../ports/out/context-store";
import type { ContextDescriptor, ContextSecrets } from "../context";
import { Context } from "../entities/context";
import { ContextAlreadyExistsError } from "../exceptions/errors";

export class CreateContextInteractor implements CreateContext {
  public constructor(private readonly store: ContextStore) {}

  public async create(name: string, payload: unknown, secrets: ContextSecrets): Promise<ContextDescriptor> {
    if (await this.store.exists(name)) {
      throw new ContextAlreadyExistsError(name);
    }
    await this.store.save(new Context(name, payload, secrets));
    return { name, payload, secrets };
  }
}
