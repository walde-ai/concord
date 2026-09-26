import { Context } from "../../domain/entities/context";
import type { LocalDeps } from "../main/local-compose";
import { closeLocalDeps } from "../main/local-compose";

export interface ContextUpsertLocalInput {
  readonly deps: LocalDeps;
  readonly name: string;
  readonly payload: unknown;
  readonly secrets: Readonly<Record<string, string>>;
}

export interface ContextUpsertLocalResult {
  readonly name: string;
  readonly payload: unknown;
  readonly secretNames: readonly string[];
}

export async function contextUpsertLocalCommand(
  input: ContextUpsertLocalInput,
): Promise<ContextUpsertLocalResult> {
  const existing = await readExisting(input.deps, input.name);
  const mergedSecrets: Record<string, string> = existing === null
    ? { ...input.secrets }
    : { ...existing.secrets, ...input.secrets };
  const context = new Context(input.name, input.payload, mergedSecrets);
  const result = await input.deps.bundle.contextStore.save(context);
  if (!result.ok) {
    throw new Error(`could not save context "${input.name}": ${result.error.message}`);
  }
  await closeLocalDeps(input.deps);
  return {
    name: input.name,
    payload: input.payload,
    secretNames: Object.keys(mergedSecrets).sort(),
  };
}

async function readExisting(
  deps: LocalDeps,
  name: string,
): Promise<{ readonly secrets: Record<string, string> } | null> {
  const exists = await deps.bundle.contextStore.exists(name);
  if (!exists) {
    return null;
  }
  const current = await deps.bundle.contextStore.getByName(name);
  return { secrets: current.secrets as Record<string, string> };
}
