import type { PeakHours } from "../../domain/peak-hours";
import type { LocalDeps } from "../main/local-compose";
import { closeLocalDeps } from "../main/local-compose";

export interface PeakHoursGetInput {
  readonly deps: LocalDeps;
}

export interface PeakHoursGetResult {
  readonly peakHours: PeakHours | null;
}

export async function peakHoursGetCommand(input: PeakHoursGetInput): Promise<PeakHoursGetResult> {
  const peakHours = await input.deps.bundle.peakHoursRepository.get();
  await closeLocalDeps(input.deps);
  return { peakHours };
}

export interface PeakHoursSetInput {
  readonly deps: LocalDeps;
  readonly value: PeakHours;
}

export async function peakHoursSetCommand(input: PeakHoursSetInput): Promise<PeakHoursGetResult> {
  await input.deps.bundle.peakHoursRepository.set(input.value);
  const peakHours = await input.deps.bundle.peakHoursRepository.get();
  await closeLocalDeps(input.deps);
  return { peakHours };
}

export interface PeakHoursClearInput {
  readonly deps: LocalDeps;
}

export async function peakHoursClearCommand(input: PeakHoursClearInput): Promise<void> {
  await input.deps.bundle.peakHoursRepository.set(null);
  await closeLocalDeps(input.deps);
}
