import { describe, it, expect } from "vitest";
import { MakeApp } from "../src/infra/main/make-app";
import { InMemoryEventStore } from "../src/infra/adapters/stores/in-memory-event-store";
import { noopLogger } from "../src/domain/ports/out/logger";
import { Consumer } from "../src/domain/entities/consumer";
import { ConsumerRegistrable } from "../src/infra/adapters/consumers/consumer-registrable";
import { InlineProducer } from "../src/infra/adapters/producers/inline/inline-producer";
import { RecordingHandler, TypeRule, successfulOutcome } from "./helpers";
import type { FinishedRun, RunCompletionHook } from "../src/domain/ports/out/run-completion-hook";
import * as publicApi from "../src/index";

class RecordingCompletionHook implements RunCompletionHook {
  public readonly finished: FinishedRun[] = [];

  public async runFinished(finished: FinishedRun): Promise<void> {
    this.finished.push(finished);
  }
}

describe("MakeApp defaults", () => {
  it("registers only the raw-json event template", () => {
    const app = MakeApp({
      eventStore: new InMemoryEventStore(),
      api: { host: "127.0.0.1", port: 0 },
      logger: noopLogger,
    });

    const templateIds = app.eventTemplateRegistry.all().map((template) => template.id);
    expect(templateIds).toEqual(["raw-json"]);
  });

  it("invokes contributed run completion hooks when a run finishes", async () => {
    const hook = new RecordingCompletionHook();
    const app = MakeApp({
      eventStore: new InMemoryEventStore(),
      logger: noopLogger,
      runCompletionHooks: [hook],
    });
    const producer = new InlineProducer("test-producer");
    app.register(producer);
    app.register(
      new ConsumerRegistrable(
        new Consumer<unknown>("c-1", new TypeRule("boom"), new RecordingHandler(successfulOutcome()), [], []),
      ),
    );
    await app.start();
    await producer.emit("pe-1", "boom", {});
    await app.awaitRuns();

    expect(hook.finished).toHaveLength(1);
    expect(hook.finished[0].state).toBe("SUCCEEDED");

    await app.stop();
  });

  it("no longer exposes deployment-specific symbols on the public surface", () => {
    const exportedNames = Object.keys(publicApi);
    const movedSymbols = [
      "AgentConsumersFactory",
      "JobFailureNotifier",
      "CHAIN_CRITICAL_CONSUMERS",
      "PipelineFixConsumer",
      "MergeConflictFixConsumer",
      "GithubFailureFixConsumer",
      "PrVerifyConsumer",
      "PrReworkConsumer",
      "PrMergeConsumer",
      "PrPublishConsumer",
      "SpecScopeConsumer",
      "SpecImplementConsumer",
      "BugfixFixConsumer",
      "WaldePipelineProducer",
      "WaldePipelineProducerFactory",
      "AwsCodePipelineClient",
      "AwsProfileResolver",
      "SpecRequestEventTemplate",
      "SpecImplementRequestEventTemplate",
      "BugfixRequestEventTemplate",
      "SPEC_REQUEST",
      "SPEC_CREATED",
      "SPEC_IMPLEMENT_REQUEST",
      "BUGFIX_REQUEST",
      "BUGFIX_COMPLETED",
      "PIPELINE_STARTED",
      "PIPELINE_FAILED",
    ];
    for (const symbol of movedSymbols) {
      expect(exportedNames).not.toContain(symbol);
    }
  });

  it("the app facade no longer carries a job failure notifier", () => {
    const app = MakeApp({ eventStore: new InMemoryEventStore(), logger: noopLogger });
    expect("jobFailureNotifier" in app).toBe(false);
  });
});
