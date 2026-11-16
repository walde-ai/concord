import { describe, it, expect } from "vitest";

import type { EventSink } from "../src/domain/ports/in/event-sink";
import type { Registration } from "../src/domain/ports/in/registration";
import type { IdGenerator } from "../src/domain/ports/out/id-generator";
import type { Clock } from "../src/domain/ports/out/clock";
import type { ContextResolver } from "../src/domain/ports/out/context-resolver";
import type { Event } from "../src/domain/entities/event";

import { runPrCodeProducing, isNoFixNeededVerdict } from "../src/infra/adapters/consumers/agents/pr-code-producing";
import type { AgentTaskRunner, CodeProducingRequest, CodeProducingResult } from "../src/infra/adapters/consumers/agents/agent-task-runner";
import type { PrEventPayload } from "../src/infra/adapters/producers/github/pull-request";
import { PR_MISSING } from "../src/infra/adapters/producers/github/pull-request";
import { InlineProducer } from "../src/infra/adapters/producers/inline/inline-producer";
import { FixedClock, SequentialIdGenerator } from "./helpers";

class RecordingTaskRunner implements Pick<AgentTaskRunner, "runCodeProducingTask" | "handoffWorktree"> {
  public readonly requests: CodeProducingRequest[] = [];
  public readonly handedOff: string[] = [];
  public constructor(private readonly result: CodeProducingResult) {}
  public async runCodeProducingTask(request: CodeProducingRequest): Promise<CodeProducingResult> {
    this.requests.push(request);
    return this.result;
  }
  public handoffWorktree(worktreePath: string): void {
    this.handedOff.push(worktreePath);
  }
}

class RecordingSink implements EventSink {
  public readonly events: Event<unknown>[] = [];
  public async emit(event: Event<unknown>): Promise<void> {
    this.events.push(event);
  }
  public async emitDetached(event: Event<unknown>): Promise<void> {
    this.events.push(event);
  }
}

function registrationWith(idGenerator: IdGenerator, clock: Clock, addProducer: (producer: InlineProducer) => void): Registration {
  return {
    idGenerator,
    clock,
    contexts: {} as ContextResolver,
    addProducer: (producer) => addProducer(producer as unknown as InlineProducer),
    addConsumer: () => {},
  };
}

class UnderTest {
  public readonly producer: InlineProducer;
  public readonly sink: RecordingSink;
  public constructor(private readonly taskRunner: RecordingTaskRunner) {
    this.sink = new RecordingSink();
    this.producer = new InlineProducer("github-failure-fix");
    this.producer.register(registrationWith(new SequentialIdGenerator(), new FixedClock(new Date("2026-11-16T00:00:00Z")), () => {}));
    void this.producer.start(this.sink);
  }
  public run(request: Omit<Parameters<typeof runPrCodeProducing>[2], "consumerId" | "runId" | "payload" | "source"> & { readonly source?: string }): Promise<ReturnType<typeof runPrCodeProducing>> {
    return runPrCodeProducing(this.taskRunner as unknown as AgentTaskRunner, this.producer, {
      consumerId: "github-failure-fix",
      runId: "run-1",
      payload: prPayload(),
      source: request.source ?? "github-failure-fix",
      prompt: request.prompt,
      schema: request.schema,
    });
  }
}

function prPayload(): PrEventPayload {
  return {
    repo: { owner: "accelerates-it", repo: "walde", url: "https://github.com/accelerates-it/walde.git" },
    number: 1575,
    title: "fix(api): the voice opening leg answers the environment-setup note",
    url: "https://github.com/accelerates-it/walde/pull/1575",
    author: "alesmag-openclaw-bot",
    draft: false,
    headSha: "0b8f3982f",
    headRef: "fix/voice-opening-setup-note",
  } as unknown as PrEventPayload;
}

const committedOnExistingPr: CodeProducingResult = {
  ok: true,
  prExists: true,
  headSha: "new-head-after-commit",
  branch: "fix/voice-opening-setup-note",
  worktreePath: "/worktrees/fix-voice-opening-setup-note",
  output: { noFixNeeded: false, summary: "fixed the guard" },
};

const headUnchanged: CodeProducingResult = {
  ok: true,
  prExists: true,
  headSha: "0b8f3982f",
  branch: "fix/voice-opening-setup-note",
  worktreePath: "/worktrees/fix-voice-opening-setup-note",
  output: null,
};

describe("runPrCodeProducing", () => {
  it("succeeds when the agent pushed a commit to the existing PR", async () => {
    const taskRunner = new RecordingTaskRunner(committedOnExistingPr);
    const underTest = new UnderTest(taskRunner);
    const outcome = await underTest.run({ prompt: "Fix the failing checks on this pull request" });
    expect(outcome).toEqual({
      ok: true,
      emitted: false,
      output: committedOnExistingPr.output,
      worktreePath: "/worktrees/fix-voice-opening-setup-note",
    });
    expect(underTest.sink.events).toHaveLength(0);
  });

  it("reports no-commit when the head is unchanged and no verdict justifies it", async () => {
    const taskRunner = new RecordingTaskRunner(headUnchanged);
    const underTest = new UnderTest(taskRunner);
    const outcome = await underTest.run({ prompt: "fix" });
    expect(outcome).toEqual({ ok: false, reason: "no-commit" });
    expect(underTest.sink.events).toHaveLength(0);
  });

  it("skips the no-commit guard for a justified no-fix verdict with unchanged head", async () => {
    // Production shape (walde#1575, 2026-11-16): the failing check was the
    // job's timeout budget cancelling a green suite — a re-run condition per
    // the recorded decision in walde#1500 — so the agent correctly pushed no
    // commit and reported noFixNeeded with the justification.
    const taskRunner = new RecordingTaskRunner({
      ...headUnchanged,
      output: { noFixNeeded: true, justification: "budget cancellation; re-ran job", rerun: true, summary: "re-run condition" },
    });
    const underTest = new UnderTest(taskRunner);
    const outcome = await underTest.run({ prompt: "fix", schema: { type: "object" } });
    expect(outcome.ok).toBe(true);
    expect(underTest.sink.events).toHaveLength(0);
  });

  it("skips the no-commit guard for an escalated verdict with unchanged head", async () => {
    const taskRunner = new RecordingTaskRunner({ ...headUnchanged, output: { escalated: true, summary: "stopped at a design decision" } });
    const underTest = new UnderTest(taskRunner);
    const outcome = await underTest.run({ prompt: "rework", schema: { type: "object" } });
    expect(outcome.ok).toBe(true);
    expect(underTest.sink.events).toHaveLength(0);
  });

  it("propagates repo-not-found without emitting", async () => {
    const taskRunner = new RecordingTaskRunner({ ok: false, reason: "repo-not-found" });
    const underTest = new UnderTest(taskRunner);
    const outcome = await underTest.run({ prompt: "fix" });
    expect(outcome).toEqual({ ok: false, reason: "repo-not-found" });
    expect(underTest.sink.events).toHaveLength(0);
  });

  it("emits pr.missing with the handed-off worktree when the branch has no PR", async () => {
    const taskRunner = new RecordingTaskRunner({ ...committedOnExistingPr, prExists: false, headSha: null });
    const underTest = new UnderTest(taskRunner);
    const outcome = await underTest.run({ prompt: "fix" });
    expect(outcome.ok).toBe(true);
    expect(underTest.sink.events).toHaveLength(1);
    expect(underTest.sink.events[0]?.type).toBe(PR_MISSING);
    expect(taskRunner.handedOff).toEqual(["/worktrees/fix-voice-opening-setup-note"]);
  });
});

describe("isNoFixNeededVerdict", () => {
  it("matches only the explicit noFixNeeded=true shape", () => {
    expect(isNoFixNeededVerdict({ noFixNeeded: true, justification: "x", summary: "y" })).toBe(true);
    expect(isNoFixNeededVerdict({ noFixNeeded: false, summary: "fixed" })).toBe(false);
    expect(isNoFixNeededVerdict({ escalated: true })).toBe(false);
    expect(isNoFixNeededVerdict(null)).toBe(false);
    expect(isNoFixNeededVerdict("text")).toBe(false);
  });
});
