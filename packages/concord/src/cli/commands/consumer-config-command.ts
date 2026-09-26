import type { ConsumerConfigValues } from "../../domain/component";
import type { LocalDeps } from "../main/local-compose";
import { closeLocalDeps } from "../main/local-compose";

export interface ConsumerConfigSetInput {
  readonly deps: LocalDeps;
  readonly consumerId: string;
  readonly values: ConsumerConfigValues;
}

export interface ConsumerConfigResult {
  readonly consumerId: string;
  readonly values: ConsumerConfigValues;
}

export async function consumerConfigSetCommand(input: ConsumerConfigSetInput): Promise<ConsumerConfigResult> {
  await input.deps.bundle.consumerConfigRepository.set(input.consumerId, input.values);
  const values = await input.deps.bundle.consumerConfigRepository.get(input.consumerId);
  await closeLocalDeps(input.deps);
  return { consumerId: input.consumerId, values };
}
