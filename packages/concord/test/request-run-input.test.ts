import { describe, it, expect } from "vitest";

import { Event } from "../src/domain/entities/event";
import { Run } from "../src/domain/entities/run";
import { RunForm, type FormDefinition } from "../src/domain/entities/run-form";
import { RequestRunInputInteractor } from "../src/domain/interactors/request-run-input-interactor";
import { SubmitRunInputInteractor } from "../src/domain/interactors/submit-run-input-interactor";
import { InMemoryRunRepository } from "../src/infra/adapters/stores/in-memory-run-repository";
import { InMemoryFormRepository } from "../src/infra/adapters/stores/in-memory-form-repository";
import { InMemoryRunInputRegistry } from "../src/infra/adapters/registry/in-memory-run-input-registry";
import { InMemoryRunAbortRegistry } from "../src/infra/adapters/registry/in-memory-run-abort-registry";
import { InMemoryRunTimeoutClock } from "../src/infra/adapters/registry/in-memory-run-timeout-clock";
import { NoOpEventLifecycleObserver } from "../src/infra/adapters/api/no-op-event-lifecycle-observer";
import { SequentialIdGenerator, FixedClock } from "./helpers";
import {
  InputRoundsExceededError,
  InvalidFormAnswersError,
  FormAlreadyAnsweredError,
  FormNotFoundError,
  RunNotPendingInputError,
} from "../src/domain/exceptions/errors";

const NOW = new Date("2026-07-06T08:00:00Z");

class RecordingProducer {
  public readonly emissions: Array<{ producerEventId: string; type: string; payload: unknown }> = [];
  public async emit(producerEventId: string, type: string, payload: unknown): Promise<void> {
    this.emissions.push({ producerEventId, type, payload });
  }
}

class ConfigResolver {
  public constructor(private readonly values: Record<string, string>) {}
  public async resolve(_consumerId: string): Promise<Record<string, string>> {
    return { ...this.values };
  }
}

async function waitForAsync<T>(probe: () => Promise<T | null>, timeoutMs = 1000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== null) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("waitForAsync timed out");
}

function makeDefinition(): FormDefinition {
  return {
    prompt: "Which approach?",
    fields: [
      { key: "plan", label: "Plan", inputType: "select", options: ["A", "B"], allowOther: false, defaultValue: "A" },
      { key: "note", label: "Note", inputType: "text", defaultValue: "" },
    ],
  };
}

function makeRunningRun(): Run<unknown> {
  const event = new Event<unknown>("evt-1", "p-1", "pevt-1", NOW, "foo", {});
  return new Run<unknown>("run-1", event, "c-1", "RUNNING", null, NOW);
}

function buildFixture(maxRounds: string) {
  const runRepository = new InMemoryRunRepository();
  const formRepository = new InMemoryFormRepository();
  const inputRegistry = new InMemoryRunInputRegistry();
  const abortRegistry = new InMemoryRunAbortRegistry();
  const timeoutClock = new InMemoryRunTimeoutClock();
  const producer = new RecordingProducer();
  const observer = new NoOpEventLifecycleObserver();
  const idGenerator = new SequentialIdGenerator();
  const clock = new FixedClock(NOW);
  const request = new RequestRunInputInteractor(
    runRepository,
    formRepository,
    inputRegistry,
    abortRegistry,
    timeoutClock,
    new ConfigResolver({ maxInputRounds: maxRounds }) as never,
    producer as never,
    idGenerator,
    clock,
    observer,
  );
  const submit = new SubmitRunInputInteractor(formRepository, inputRegistry, clock);
  return { runRepository, formRepository, inputRegistry, abortRegistry, timeoutClock, producer, request, submit };
}

describe("RequestRunInputInteractor", () => {
  it("creates a PENDING form, parks the run, emits run.input_requested, and blocks until submitted", async () => {
    const { runRepository, formRepository, producer, request, submit } = buildFixture("3");
    await runRepository.save(makeRunningRun());

    const promise = request.request("run-1", makeDefinition());
    const form = await waitForAsync(() => formRepository.getPendingByRun("run-1"));

    const parked = await runRepository.getById("run-1");
    expect(parked.state).toBe("PENDING_INPUT");

    expect(producer.emissions).toHaveLength(1);
    expect(producer.emissions[0].type).toBe("run.input_requested");
    expect(producer.emissions[0].producerEventId).toBe("run-1/input/id-1");
    const payload = producer.emissions[0].payload as { runId: string; formId: string; round: number; prompt: string };
    expect(payload.runId).toBe("run-1");
    expect(payload.formId).toBe(form.id);
    expect(payload.round).toBe(1);
    expect(payload.prompt).toBe("Which approach?");

    expect(form.status).toBe("PENDING");
    expect(form.round).toBe(1);

    const submitted = await submit.submit("run-1", form.id, { plan: "B", note: "ok", extraNotes: "" });
    expect(submitted.status).toBe("ANSWERED");

    const answers = await promise;
    expect(answers).toEqual({ plan: "B", note: "ok", extraNotes: "" });

    const resumed = await runRepository.getById("run-1");
    expect(resumed.state).toBe("RUNNING");
  });

  it("creates a round-2 form after the first round resolves", async () => {
    const { runRepository, formRepository, request, submit } = buildFixture("3");
    await runRepository.save(makeRunningRun());

    const first = request.request("run-1", makeDefinition());
    const form1 = await waitForAsync(() => formRepository.getPendingByRun("run-1"));
    await submit.submit("run-1", form1.id, { plan: "A", note: "x", extraNotes: "" });
    await first;

    const second = request.request("run-1", makeDefinition());
    const form2 = await waitForAsync(() =>
      formRepository.listByRun("run-1").then((list) => list.find((f) => f.round === 2) ?? null),
    );
    expect(form2.round).toBe(2);

    await submit.submit("run-1", form2.id, { plan: "B", note: "y", extraNotes: "" });
    await second;
  });

  it("throws InputRoundsExceededError when the persisted count reaches the limit and creates no form", async () => {
    const { runRepository, formRepository, request, submit } = buildFixture("1");
    await runRepository.save(makeRunningRun());

    const first = request.request("run-1", makeDefinition());
    const form1 = await waitForAsync(() => formRepository.getPendingByRun("run-1"));
    await submit.submit("run-1", form1.id, { plan: "A", note: "x", extraNotes: "" });
    await first;

    await expect(request.request("run-1", makeDefinition())).rejects.toBeInstanceOf(InputRoundsExceededError);
    expect(await formRepository.countByRun("run-1")).toBe(1);
  });

  it("throws InputRoundsExceededError immediately when maxInputRounds is zero", async () => {
    const { runRepository, formRepository, request } = buildFixture("0");
    await runRepository.save(makeRunningRun());

    await expect(request.request("run-1", makeDefinition())).rejects.toBeInstanceOf(InputRoundsExceededError);
    expect(await formRepository.countByRun("run-1")).toBe(0);
  });

  it("rejects invalid form definitions before any state change", async () => {
    const { runRepository, formRepository, request } = buildFixture("3");
    await runRepository.save(makeRunningRun());

    await expect(
      request.request("run-1", { prompt: "x", fields: [] }),
    ).rejects.toBeInstanceOf(InvalidFormAnswersError);
    await expect(
      request.request("run-1", { prompt: "", fields: [{ key: "a", label: "A", inputType: "text", defaultValue: "" }] }),
    ).rejects.toBeInstanceOf(InvalidFormAnswersError);

    const run = await runRepository.getById("run-1");
    expect(run.state).toBe("RUNNING");
    expect(await formRepository.countByRun("run-1")).toBe(0);
  });

  it("rejects the parked promise when the run is aborted", async () => {
    const { runRepository, formRepository, abortRegistry, request } = buildFixture("3");
    await runRepository.save(makeRunningRun());

    const controller = new AbortController();
    let resolveCompletion!: (run: Run<unknown>) => void;
    const completion = new Promise<Run<unknown>>((resolve) => {
      resolveCompletion = resolve;
    });
    abortRegistry.register("run-1", { controller, completion, resolve: resolveCompletion });

    const promise = request.request("run-1", makeDefinition());
    await waitForAsync(() => formRepository.getPendingByRun("run-1"));

    controller.abort();

    await expect(promise).rejects.toThrow();
    const after = await runRepository.getById("run-1");
    expect(after.state).toBe("PENDING_INPUT");
  });

  it("always appends a free-text 'Extra notes' field to the persisted form, whatever the caller asked for", async () => {
    const { runRepository, formRepository, request } = buildFixture("3");
    await runRepository.save(makeRunningRun());

    void request.request("run-1", makeDefinition());
    const form = await waitForAsync(() => formRepository.getPendingByRun("run-1"));

    const keys = form.fields.map((field) => field.key);
    expect(keys).toContain("extraNotes");
    const notes = form.fields.find((field) => field.key === "extraNotes");
    expect(notes?.inputType).toBe("textarea");
    // It is appended last.
    expect(keys[keys.length - 1]).toBe("extraNotes");
  });

  it("does not add a second Extra notes field when the caller already used the reserved key", async () => {
    const { runRepository, formRepository, request } = buildFixture("3");
    await runRepository.save(makeRunningRun());

    const definition: FormDefinition = {
      prompt: "Which approach?",
      fields: [
        { key: "plan", label: "Plan", inputType: "select", options: ["A", "B"], allowOther: false, defaultValue: "A" },
        { key: "extraNotes", label: "Extra notes", inputType: "textarea", defaultValue: "keep mine" },
      ],
    };
    void request.request("run-1", definition);
    const form = await waitForAsync(() => formRepository.getPendingByRun("run-1"));

    const notesFields = form.fields.filter((field) => field.key === "extraNotes");
    expect(notesFields).toHaveLength(1);
    expect((notesFields[0] as { defaultValue: string }).defaultValue).toBe("keep mine");
  });

  it("persists the caller-supplied Markdown context on the form", async () => {
    const { runRepository, formRepository, request } = buildFixture("3");
    await runRepository.save(makeRunningRun());

    const definition: FormDefinition = { ...makeDefinition(), context: "## Analysis\nI read the code." };
    void request.request("run-1", definition);
    const form = await waitForAsync(() => formRepository.getPendingByRun("run-1"));

    expect(form.context).toBe("## Analysis\nI read the code.");
  });
});

describe("SubmitRunInputInteractor", () => {
  it("throws FormNotFoundError for an unknown form id", async () => {
    const { submit } = buildFixture("3");
    await expect(submit.submit("run-1", "missing", { plan: "A" })).rejects.toBeInstanceOf(FormNotFoundError);
  });

  it("throws FormAlreadyAnsweredError when submitting an answered form", async () => {
    const { runRepository, formRepository, request, submit } = buildFixture("3");
    await runRepository.save(makeRunningRun());

    const promise = request.request("run-1", makeDefinition());
    const form = await waitForAsync(() => formRepository.getPendingByRun("run-1"));
    await submit.submit("run-1", form.id, { plan: "A", note: "x", extraNotes: "" });
    await promise;

    await expect(submit.submit("run-1", form.id, { plan: "A", note: "x", extraNotes: "" })).rejects.toBeInstanceOf(
      FormAlreadyAnsweredError,
    );
  });

  it("throws RunNotPendingInputError when no input handle exists", async () => {
    const runRepository = new InMemoryRunRepository();
    const formRepository = new InMemoryFormRepository();
    const inputRegistry = new InMemoryRunInputRegistry();
    const clock = new FixedClock(NOW);
    const submit = new SubmitRunInputInteractor(formRepository, inputRegistry, clock);

    await runRepository.save(makeRunningRun());
    const form = new RunForm("f-1", "run-1", "c-1", 1, "q", makeDefinition().fields, "PENDING", null, NOW);
    await formRepository.save(form);

    await expect(submit.submit("run-1", "f-1", { plan: "A", note: "x" })).rejects.toBeInstanceOf(
      RunNotPendingInputError,
    );
  });

  it("throws InvalidFormAnswersError for malformed answers", async () => {
    const { runRepository, formRepository, request, submit } = buildFixture("3");
    await runRepository.save(makeRunningRun());

    void request.request("run-1", makeDefinition());
    const form = await waitForAsync(() => formRepository.getPendingByRun("run-1"));

    await expect(submit.submit("run-1", form.id, { note: "x" } as never)).rejects.toBeInstanceOf(InvalidFormAnswersError);
    await expect(
      submit.submit("run-1", form.id, { plan: ["A"], note: "x" } as never),
    ).rejects.toBeInstanceOf(InvalidFormAnswersError);
    await expect(
      submit.submit("run-1", form.id, { plan: "C", note: "x" }),
    ).rejects.toBeInstanceOf(InvalidFormAnswersError);
  });

  it("allows a select 'Other' value when allowOther is true", async () => {
    const runRepository = new InMemoryRunRepository();
    const formRepository = new InMemoryFormRepository();
    const inputRegistry = new InMemoryRunInputRegistry();
    const clock = new FixedClock(NOW);
    const submit = new SubmitRunInputInteractor(formRepository, inputRegistry, clock);
    await runRepository.save(makeRunningRun());
    const form = new RunForm(
      "f-1",
      "run-1",
      "c-1",
      1,
      "q",
      [{ key: "plan", label: "Plan", inputType: "select", options: ["A"], allowOther: true, defaultValue: "A" }],
      "PENDING",
      null,
      NOW,
    );
    await formRepository.save(form);
    inputRegistry.register("run-1", makeResolvableHandle());

    const result = await submit.submit("run-1", "f-1", { plan: "custom-value" });
    expect(result.answers).toEqual({ plan: "custom-value" });
  });

  it("allows at most one checkbox 'Other' value when allowOther is true", async () => {
    const runRepository = new InMemoryRunRepository();
    const formRepository = new InMemoryFormRepository();
    const inputRegistry = new InMemoryRunInputRegistry();
    const clock = new FixedClock(NOW);
    const submit = new SubmitRunInputInteractor(formRepository, inputRegistry, clock);
    await runRepository.save(makeRunningRun());

    const form = new RunForm(
      "f-1",
      "run-1",
      "c-1",
      1,
      "q",
      [{ key: "tags", label: "Tags", inputType: "checkbox", options: ["x"], allowOther: true, defaultValue: ["x"] }],
      "PENDING",
      null,
      NOW,
    );
    await formRepository.save(form);
    inputRegistry.register("run-1", makeResolvableHandle());

    const ok = await submit.submit("run-1", "f-1", { tags: ["x", "custom"] });
    expect(ok.answers).toEqual({ tags: ["x", "custom"] });

    const second = new RunForm(
      "f-2",
      "run-1",
      "c-1",
      2,
      "q",
      [{ key: "tags", label: "Tags", inputType: "checkbox", options: ["x"], allowOther: true, defaultValue: ["x"] }],
      "PENDING",
      null,
      NOW,
    );
    await formRepository.save(second);
    inputRegistry.register("run-1", makeResolvableHandle());
    await expect(
      submit.submit("run-1", "f-2", { tags: ["x", "c1", "c2"] }),
    ).rejects.toBeInstanceOf(InvalidFormAnswersError);
  });
});

function makeResolvableHandle() {
  let resolveFn!: (answers: Record<string, string | string[]>) => void;
  const promise = new Promise<Record<string, string | string[]>>((resolve) => {
    resolveFn = resolve;
  });
  return { promise, resolve: resolveFn, reject: () => {} };
}
