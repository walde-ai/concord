import type { LocalDeps } from "../main/local-compose";
import { closeLocalDeps } from "../main/local-compose";

export interface PauseGetInput {
  readonly deps: LocalDeps;
}

export interface PauseGetResult {
  readonly paused: boolean;
}

export async function pauseGetCommand(input: PauseGetInput): Promise<PauseGetResult> {
  const paused = await input.deps.bundle.pauseStateRepository.isPaused();
  await closeLocalDeps(input.deps);
  return { paused };
}

export interface PauseSetInput {
  readonly deps: LocalDeps;
  readonly paused: boolean;
}

export async function pauseSetCommand(input: PauseSetInput): Promise<PauseGetResult> {
  await input.deps.bundle.pauseStateRepository.setPaused(input.paused);
  const paused = await input.deps.bundle.pauseStateRepository.isPaused();
  await closeLocalDeps(input.deps);
  return { paused };
}
