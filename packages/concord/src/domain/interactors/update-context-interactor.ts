import type { UpdateContext } from "../ports/in/update-context";
import type { ContextStore } from "../ports/out/context-store";
import type { ContextDescriptor, ContextSecrets, SecretOperation } from "../context";
import { Context } from "../entities/context";
import { ContextNotFoundError } from "../exceptions/errors";

export class UpdateContextInteractor implements UpdateContext {
  public constructor(private readonly store: ContextStore) {}

  public async update(name: string, payload: unknown, secrets: SecretOperation): Promise<ContextDescriptor> {
    if (!(await this.store.exists(name))) {
      throw new ContextNotFoundError(name);
    }
    const existing = await this.store.getByName(name);
    const merged = applySecretOperation(existing.secrets, secrets);
    await this.store.save(new Context(name, payload, merged));
    return { name, payload, secrets: merged };
  }
}

function applySecretOperation(current: Readonly<ContextSecrets>, operation: SecretOperation): ContextSecrets {
  const merged: ContextSecrets = { ...current };
  for (const upsert of operation.upserts) {
    merged[upsert.name] = upsert.value;
  }
  for (const name of operation.deletes) {
    delete merged[name];
  }
  return merged;
}
