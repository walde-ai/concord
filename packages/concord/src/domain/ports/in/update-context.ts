import type { ContextDescriptor, SecretOperation } from "../../context";

export interface UpdateContext {
  update(name: string, payload: unknown, secrets: SecretOperation): Promise<ContextDescriptor>;
}
