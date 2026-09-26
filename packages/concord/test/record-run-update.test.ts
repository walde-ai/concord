import { describe, it, expect } from "vitest";

import { Event } from "../src/domain/entities/event";
import { Run } from "../src/domain/entities/run";
import {
  RecordRunUpdateInteractor,
  InvalidRunUpdateMessageError,
  MAX_RUN_UPDATE_MESSAGE_BYTES,
} from "../src/domain/interactors/record-run-update-interactor";
import { InMemoryRunRepository } from "../src/infra/adapters/stores/in-memory-run-repository";
import { InMemoryRunUpdateRepository } from "../src/infra/adapters/stores/in-memory-run-update-repository";
import { RunNotFoundError } from "../src/domain/exceptions/errors";
import { SequentialIdGenerator, FixedClock } from "./helpers";

const NOW = new Date("2026-07-28T09:00:00Z");

function makeRunningRun(): Run<unknown> {
  const event = new Event<unknown>("evt-1", "p-1", "pevt-1", NOW, "foo", {});
  return new Run<unknown>("run-1", event, "consumer-7", "RUNNING", null, NOW);
}

function buildFixture() {
  const runRepository = new InMemoryRunRepository();
  const runUpdateRepository = new InMemoryRunUpdateRepository();
  const idGenerator = new SequentialIdGenerator();
  const clock = new FixedClock(NOW);
  const record = new RecordRunUpdateInteractor(runUpdateRepository, runRepository, idGenerator, clock);
  return { runRepository, runUpdateRepository, record };
}

describe("RecordRunUpdateInteractor", () => {
  it("creates and persists a RunUpdate with the resolved consumerId, generated id, and timestamp", async () => {
    const { runRepository, runUpdateRepository, record } = buildFixture();
    await runRepository.save(makeRunningRun());

    const update = await record.record("run-1", "Halfway through the refactor.");

    expect(update.id).toBe("id-1");
    expect(update.runId).toBe("run-1");
    expect(update.consumerId).toBe("consumer-7");
    expect(update.message).toBe("Halfway through the refactor.");
    expect(update.createdAt).toEqual(NOW);

    const persisted = await runUpdateRepository.listByRun("run-1");
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toEqual(update);
  });

  it("rejects an empty message before any state change", async () => {
    const { runRepository, runUpdateRepository, record } = buildFixture();
    await runRepository.save(makeRunningRun());

    await expect(record.record("run-1", "")).rejects.toBeInstanceOf(InvalidRunUpdateMessageError);
    await expect(record.record("run-1", "   ")).resolves.toBeDefined();
    expect(await runUpdateRepository.listByRun("run-1")).toHaveLength(1);
  });

  it("rejects a message over the byte limit", async () => {
    const { runRepository, runUpdateRepository, record } = buildFixture();
    await runRepository.save(makeRunningRun());

    const overlong = "x".repeat(MAX_RUN_UPDATE_MESSAGE_BYTES + 1);
    await expect(record.record("run-1", overlong)).rejects.toBeInstanceOf(InvalidRunUpdateMessageError);
    expect(await runUpdateRepository.listByRun("run-1")).toHaveLength(0);
  });

  it("throws RunNotFoundError when the run does not exist", async () => {
    const { record } = buildFixture();

    await expect(record.record("missing", "hello")).rejects.toBeInstanceOf(RunNotFoundError);
  });
});
