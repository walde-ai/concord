import type { DeleteContext } from "../ports/in/delete-context";
import type { ContextStore } from "../ports/out/context-store";
import { ContextNotFoundError } from "../exceptions/errors";

export class DeleteContextInteractor implements DeleteContext {
  public constructor(private readonly store: ContextStore) {}

  public async delete(name: string): Promise<void> {
    if (!(await this.store.exists(name))) {
      throw new ContextNotFoundError(name);
    }
    await this.store.delete(name);
  }
}
