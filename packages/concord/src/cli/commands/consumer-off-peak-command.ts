import type { LocalDeps } from "../main/local-compose";
import { closeLocalDeps } from "../main/local-compose";

export interface ConsumerOffPeakInput {
  readonly deps: LocalDeps;
  readonly consumerId: string;
  readonly waitForOffPeak: boolean;
}

export interface ConsumerOffPeakResult {
  readonly consumerId: string;
  readonly waitForOffPeak: boolean;
}

export async function consumerOffPeakCommand(input: ConsumerOffPeakInput): Promise<ConsumerOffPeakResult> {
  await input.deps.bundle.consumerStateRepository.setWaitForOffPeak(input.consumerId, input.waitForOffPeak);
  const waitForOffPeak = await input.deps.bundle.consumerStateRepository.getWaitForOffPeak(input.consumerId);
  await closeLocalDeps(input.deps);
  return { consumerId: input.consumerId, waitForOffPeak };
}
