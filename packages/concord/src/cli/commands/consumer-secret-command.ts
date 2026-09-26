import type { SecretOperation } from "../../domain/context";
import type { LocalDeps } from "../main/local-compose";
import { closeLocalDeps } from "../main/local-compose";

export interface ConsumerSecretSetInput {
  readonly deps: LocalDeps;
  readonly consumerId: string;
  readonly operation: SecretOperation;
}

export interface ConsumerSecretResult {
  readonly consumerId: string;
  readonly secretNames: readonly string[];
}

export async function consumerSecretSetCommand(input: ConsumerSecretSetInput): Promise<ConsumerSecretResult> {
  await input.deps.bundle.consumerConfigRepository.applySecretOperation(input.consumerId, input.operation);
  const secrets = await input.deps.bundle.consumerConfigRepository.getSecrets(input.consumerId);
  await closeLocalDeps(input.deps);
  return { consumerId: input.consumerId, secretNames: Object.keys(secrets).sort() };
}
