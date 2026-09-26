import type { LocalDeps } from "../main/local-compose";
import { closeLocalDeps } from "../main/local-compose";

export type ComponentKind = "consumer" | "producer";

export interface ComponentEnabledInput {
  readonly deps: LocalDeps;
  readonly kind: ComponentKind;
  readonly id: string;
  readonly enabled: boolean;
}

export interface ComponentEnabledResult {
  readonly kind: ComponentKind;
  readonly id: string;
  readonly enabled: boolean;
}

export async function componentEnabledCommand(input: ComponentEnabledInput): Promise<ComponentEnabledResult> {
  if (input.kind === "consumer") {
    await input.deps.bundle.consumerStateRepository.setEnabled(input.id, input.enabled);
  } else {
    await input.deps.bundle.producerStateRepository.setEnabled(input.id, input.enabled);
  }
  await closeLocalDeps(input.deps);
  return { kind: input.kind, id: input.id, enabled: input.enabled };
}
