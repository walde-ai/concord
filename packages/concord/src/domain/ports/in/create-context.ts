import type { ContextDescriptor, ContextSecrets } from "../../context";

export interface CreateContext {
  create(name: string, payload: unknown, secrets: ContextSecrets): Promise<ContextDescriptor>;
}
