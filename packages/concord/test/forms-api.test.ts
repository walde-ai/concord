import { describe, it, expect, afterEach } from "vitest";

import { Event } from "../src/domain/entities/event";
import { Run } from "../src/domain/entities/run";
import { RunForm } from "../src/domain/entities/run-form";
import { RunUpdate } from "../src/domain/entities/run-update";
import { SubmitRunInputInteractor } from "../src/domain/interactors/submit-run-input-interactor";
import { InMemoryEventStore } from "../src/infra/adapters/stores/in-memory-event-store";
import { InMemoryRunRepository } from "../src/infra/adapters/stores/in-memory-run-repository";
import { InMemoryFormRepository } from "../src/infra/adapters/stores/in-memory-form-repository";
import { InMemoryRunUpdateRepository } from "../src/infra/adapters/stores/in-memory-run-update-repository";
import { InMemoryRunInputRegistry } from "../src/infra/adapters/registry/in-memory-run-input-registry";
import { StreamBroadcaster } from "../src/infra/adapters/api/stream-broadcaster";
import { HttpApiServer } from "../src/infra/adapters/api/http-api-server";
import { FixedClock } from "./helpers";

const NOW = new Date("2026-07-06T08:00:00Z");

interface Boot {
  readonly baseUrl: string;
  readonly runRepository: InMemoryRunRepository;
  readonly formRepository: InMemoryFormRepository;
  readonly runUpdateRepository: InMemoryRunUpdateRepository;
  readonly inputRegistry: InMemoryRunInputRegistry;
  readonly server: HttpApiServer;
}

let server: HttpApiServer | null = null;
afterEach(async () => {
  if (server !== null) {
    await server.close();
    server = null;
  }
});

function boot(): Boot {
  const eventStore = new InMemoryEventStore();
  const runRepository = new InMemoryRunRepository();
  const formRepository = new InMemoryFormRepository();
  const runUpdateRepository = new InMemoryRunUpdateRepository();
  const inputRegistry = new InMemoryRunInputRegistry();
  const clock = new FixedClock(NOW);
  const broadcaster = new StreamBroadcaster();
  const submitRunInput = new SubmitRunInputInteractor(formRepository, inputRegistry, clock);
  server = new HttpApiServer(
    "127.0.0.1",
    0,
    eventStore,
    runRepository,
    broadcaster,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    submitRunInput,
    formRepository,
    runUpdateRepository,
  );
  return {
    baseUrl: "",
    runRepository,
    formRepository,
    runUpdateRepository,
    inputRegistry,
    server: server,
  };
}

async function startServer(s: HttpApiServer): Promise<string> {
  await s.start();
  return `http://127.0.0.1:${s.address!.port}`;
}

async function getJson(baseUrl: string, path: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}${path}`);
  const body = await response.json();
  return { status: response.status, body };
}

async function postJson(baseUrl: string, path: string, payload: unknown): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.json();
  return { status: response.status, body };
}

function seedRun(state: Run<unknown>["state"] = "RUNNING"): Run<unknown> {
  const event = new Event<unknown>("evt-1", "p-1", "pevt-1", NOW, "foo", {});
  return new Run<unknown>("run-1", event, "c-1", state, null, NOW);
}

function seedForm(id: string, runId: string, round: number, status: "PENDING" | "ANSWERED"): RunForm {
  return new RunForm(
    id,
    runId,
    "c-1",
    round,
    "Which?",
    [
      { key: "plan", label: "Plan", inputType: "select", options: ["A", "B"], allowOther: false, defaultValue: "A" },
      { key: "note", label: "Note", inputType: "text", defaultValue: "" },
    ],
    status,
    status === "ANSWERED" ? { plan: "A", note: "x" } : null,
    NOW,
    status === "ANSWERED" ? NOW : null,
  );
}

describe("Run forms API", () => {
  it("GET /api/runs/:id/forms returns forms ordered by ascending round", async () => {
    const fixture = boot();
    await fixture.runRepository.save(seedRun());
    await fixture.formRepository.save(seedForm("form-2", "run-1", 2, "ANSWERED"));
    await fixture.formRepository.save(seedForm("form-1", "run-1", 1, "ANSWERED"));
    const baseUrl = await startServer(fixture.server);

    const result = await getJson(baseUrl, "/api/runs/run-1/forms");
    expect(result.status).toBe(200);
    const body = result.body as { ok: boolean; data: { items: { id: string; round: number; status: string }[] } };
    expect(body.data.items.map((f) => f.id)).toEqual(["form-1", "form-2"]);
    expect(body.data.items[0].round).toBe(1);
  });

  it("GET /api/runs/:id/forms returns NOT_FOUND for an unknown run", async () => {
    const fixture = boot();
    const baseUrl = await startServer(fixture.server);

    const result = await getJson(baseUrl, "/api/runs/missing/forms");
    expect(result.status).toBe(404);
    const body = result.body as { ok: boolean; error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("POST /api/runs/:id/forms/:formId/submit with valid answers returns the updated ANSWERED form", async () => {
    const fixture = boot();
    await fixture.runRepository.save(seedRun());
    await fixture.formRepository.save(seedForm("form-1", "run-1", 1, "PENDING"));
    const baseUrl = await startServer(fixture.server);

    const handle = makeHandle();
    fixture.inputRegistry.register("run-1", handle);

    const result = await postJson(baseUrl, "/api/runs/run-1/forms/form-1/submit", {
      answers: { plan: "B", note: "ok" },
    });
    expect(result.status).toBe(200);
    const body = result.body as { ok: boolean; data: { status: string; answers: Record<string, unknown> } };
    expect(body.data.status).toBe("ANSWERED");
    expect(body.data.answers).toEqual({ plan: "B", note: "ok" });
    const resolved = await handle.promise;
    expect(resolved).toEqual({ plan: "B", note: "ok" });
  });

  it("POST submit for an answered form returns CONFLICT", async () => {
    const fixture = boot();
    await fixture.runRepository.save(seedRun());
    await fixture.formRepository.save(seedForm("form-1", "run-1", 1, "ANSWERED"));
    const baseUrl = await startServer(fixture.server);

    const result = await postJson(baseUrl, "/api/runs/run-1/forms/form-1/submit", {
      answers: { plan: "A", note: "x" },
    });
    expect(result.status).toBe(409);
    const body = result.body as { ok: boolean; error: { code: string } };
    expect(body.error.code).toBe("CONFLICT");
  });

  it("POST submit when no pending handle exists returns CONFLICT", async () => {
    const fixture = boot();
    await fixture.runRepository.save(seedRun());
    await fixture.formRepository.save(seedForm("form-1", "run-1", 1, "PENDING"));
    const baseUrl = await startServer(fixture.server);

    const result = await postJson(baseUrl, "/api/runs/run-1/forms/form-1/submit", {
      answers: { plan: "A", note: "x" },
    });
    expect(result.status).toBe(409);
  });

  it("POST submit with a malformed answers payload returns BAD_REQUEST", async () => {
    const fixture = boot();
    await fixture.runRepository.save(seedRun());
    await fixture.formRepository.save(seedForm("form-1", "run-1", 1, "PENDING"));
    const baseUrl = await startServer(fixture.server);

    const missingKey = await postJson(baseUrl, "/api/runs/run-1/forms/form-1/submit", { answers: { note: "x" } });
    expect(missingKey.status).toBe(400);

    const wrongShape = await postJson(baseUrl, "/api/runs/run-1/forms/form-1/submit", {
      answers: { plan: ["A"], note: "x" },
    });
    expect(wrongShape.status).toBe(400);

    const notAnObject = await postJson(baseUrl, "/api/runs/run-1/forms/form-1/submit", { answers: "nope" });
    expect(notAnObject.status).toBe(400);
  });

  it("POST submit for an unknown form returns NOT_FOUND", async () => {
    const fixture = boot();
    await fixture.runRepository.save(seedRun());
    const baseUrl = await startServer(fixture.server);

    const result = await postJson(baseUrl, "/api/runs/run-1/forms/missing/submit", {
      answers: { plan: "A", note: "x" },
    });
    expect(result.status).toBe(404);
  });
});

function makeHandle() {
  let resolveFn!: (answers: Record<string, string | string[]>) => void;
  const promise = new Promise<Record<string, string | string[]>>((resolve) => {
    resolveFn = resolve;
  });
  return { promise, resolve: resolveFn, reject: () => {} };
}

describe("Run updates API", () => {
  it("GET /api/runs/:id/updates returns persisted updates ordered ascending by creation time", async () => {
    const fixture = boot();
    await fixture.runRepository.save(seedRun());
    await fixture.runUpdateRepository.save(
      new RunUpdate("update-2", "run-1", "c-1", "second", new Date("2026-07-28T10:00:00Z")),
    );
    await fixture.runUpdateRepository.save(
      new RunUpdate("update-1", "run-1", "c-1", "first", new Date("2026-07-28T09:00:00Z")),
    );
    const baseUrl = await startServer(fixture.server);

    const result = await getJson(baseUrl, "/api/runs/run-1/updates");
    expect(result.status).toBe(200);
    const body = result.body as {
      ok: boolean;
      data: { items: { id: string; message: string; createdAt: string }[] };
    };
    expect(body.data.items.map((u) => u.id)).toEqual(["update-1", "update-2"]);
    expect(body.data.items[0].message).toBe("first");
  });

  it("GET /api/runs/:id/updates returns an empty items array when the run has no updates", async () => {
    const fixture = boot();
    await fixture.runRepository.save(seedRun());
    const baseUrl = await startServer(fixture.server);

    const result = await getJson(baseUrl, "/api/runs/run-1/updates");
    expect(result.status).toBe(200);
    const body = result.body as { ok: boolean; data: { items: unknown[] } };
    expect(body.data.items).toEqual([]);
  });

  it("GET /api/runs/:id/updates returns NOT_FOUND for an unknown run", async () => {
    const fixture = boot();
    const baseUrl = await startServer(fixture.server);

    const result = await getJson(baseUrl, "/api/runs/missing/updates");
    expect(result.status).toBe(404);
    const body = result.body as { ok: boolean; error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });
});
