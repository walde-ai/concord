import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { setActivePinia, createPinia } from "pinia";
import { useConcordStore } from "./use-concord-store";
import type { StreamFrame, RunActivityFrame } from "../infra/types";

describe("useConcordStore", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("prepends an event on the event.created frame", () => {
    const store = useConcordStore();

    const frame: StreamFrame = {
      type: "event.created",
      data: { id: "evt-1", producerId: "p-1", datetime: "2026-07-04T00:00:00Z", type: "foo", payload: {}, muted: false },
    };

    store.handleFrame(frame);

    expect(store.events).toHaveLength(1);
    expect(store.events[0].id).toBe("evt-1");
  });

  it("updates a run in place on the run.state_changed frame", () => {
    const store = useConcordStore();

    store.handleFrame({
      type: "run.created",
      data: { id: "run-1", state: "NOT_STARTED", event: { id: "evt-1", producerId: "p", datetime: "", type: "foo", payload: {}, muted: false } },
    });

    store.handleFrame({
      type: "run.state_changed",
      data: { id: "run-1", state: "SUCCEEDED", event: { id: "evt-1", producerId: "p", datetime: "", type: "foo", payload: {}, muted: false } },
    });

    expect(store.runs).toHaveLength(1);
    expect(store.runs[0].state).toBe("SUCCEEDED");
  });
});

describe("useConcordStore — producers", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.restoreAllMocks();
  });

  it("populates the producers ref on loadProducers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        json: () =>
          Promise.resolve({
            ok: true,
            data: [{ id: "p-1", enabled: true, disableable: true }],
          }),
      }),
    );

    const store = useConcordStore();
    await store.loadProducers();

    expect(store.producers).toEqual([{ id: "p-1", enabled: true, disableable: true }]);
  });

  it("optimistically updates the matching producer on setProducerEnabled", async () => {
    const store = useConcordStore();
    store.producers = [{ id: "p-1", enabled: true, disableable: true }];

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        json: () => Promise.resolve({ ok: true, data: { id: "p-1", enabled: false, disableable: true } }),
      }),
    );

    await store.setProducerEnabled("p-1", false);

    expect(store.producers[0].enabled).toBe(false);
  });

  it("rolls the producer back to its previous value on client failure", async () => {
    const store = useConcordStore();
    store.producers = [{ id: "p-1", enabled: true, disableable: true }];

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        json: () =>
          Promise.resolve({
            ok: false,
            error: { code: "INTERNAL", message: "boom" },
          }),
      }),
    );

    await store.setProducerEnabled("p-1", false);

    expect(store.producers[0].enabled).toBe(true);
    expect(store.error).toBe("boom");
  });
});

describe("useConcordStore — contexts actions", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    setActivePinia(createPinia());
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("loadContexts populates the contexts ref from the list result", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      json: () =>
        Promise.resolve({
          ok: true,
          data: {
            items: [
              { name: "alpha", payload: { n: 1 }, secretNames: [] },
              { name: "bravo", payload: { n: 2 }, secretNames: ["TOKEN"] },
            ],
            total: 2,
            limit: 50,
            offset: 0,
          },
        }),
    }) as unknown as typeof globalThis.fetch;

    const store = useConcordStore();
    await store.loadContexts();

    expect(store.contexts).toHaveLength(2);
    expect(store.contexts[0].name).toBe("alpha");
    expect(store.contexts[1].secretNames).toEqual(["TOKEN"]);
    expect(store.contextsTotal).toBe(2);
  });

  it("createContext prepends the returned DTO and bumps the total", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      json: () =>
        Promise.resolve({
          ok: true,
          data: { name: "greeting", payload: { hello: "world" }, secretNames: ["TOKEN"] },
        }),
    }) as unknown as typeof globalThis.fetch;

    const store = useConcordStore();
    store.contexts = [{ name: "alpha", payload: { n: 1 }, secretNames: [] }];
    store.contextsTotal = 1;

    await store.createContext("greeting", { hello: "world" }, [{ name: "TOKEN", value: "abc" }]);

    expect(store.contexts).toHaveLength(2);
    expect(store.contexts[0].name).toBe("greeting");
    expect(store.contexts[0].secretNames).toEqual(["TOKEN"]);
    expect(store.contextsTotal).toBe(2);
  });

  it("updateContext applies the payload optimistically and rolls back on client failure", async () => {
    let shouldFail = true;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      if (shouldFail) {
        return Promise.resolve({
          json: () =>
            Promise.resolve({ ok: false, error: { code: "INTERNAL", message: "boom" } }),
        });
      }
      return Promise.resolve({
        json: () =>
          Promise.resolve({
            ok: true,
            data: { name: "greeting", payload: { hello: "updated" }, secretNames: ["NEW"] },
          }),
      });
    }) as unknown as typeof globalThis.fetch;

    const store = useConcordStore();
    store.contexts = [{ name: "greeting", payload: { hello: "original" }, secretNames: ["OLD"] }];
    store.contextsTotal = 1;

    await store.updateContext("greeting", { hello: "updated" }, {
      upserts: [{ name: "NEW", value: "x" }],
      deletes: ["OLD"],
    });

    expect(store.contexts[0].payload).toEqual({ hello: "original" });
    expect(store.contexts[0].secretNames).toEqual(["OLD"]);
    expect(store.error).toBe("boom");

    shouldFail = false;
    store.error = null;
    await store.updateContext("greeting", { hello: "updated" }, {
      upserts: [{ name: "NEW", value: "x" }],
      deletes: ["OLD"],
    });
    expect(store.contexts[0].payload).toEqual({ hello: "updated" });
    expect(store.contexts[0].secretNames).toEqual(["NEW"]);
  });

  it("deleteContext removes the matching item and decrements the total", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ ok: true, data: { name: "greeting" } }),
    }) as unknown as typeof globalThis.fetch;

    const store = useConcordStore();
    store.contexts = [
      { name: "greeting", payload: { hello: "world" }, secretNames: [] },
      { name: "alpha", payload: { n: 1 }, secretNames: [] },
    ];
    store.contextsTotal = 2;

    await store.deleteContext("greeting");

    expect(store.contexts).toHaveLength(1);
    expect(store.contexts[0].name).toBe("alpha");
    expect(store.contextsTotal).toBe(1);
  });
});

describe("useConcordStore — pause, replay, abort, restart", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    setActivePinia(createPinia());
    originalFetch = globalThis.fetch;
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("loadPauseState populates the paused ref from the response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ ok: true, data: { paused: true } }),
    }) as unknown as typeof globalThis.fetch;

    const store = useConcordStore();
    await store.loadPauseState();

    expect(store.paused).toBe(true);
  });

  it("setPauseState applies the change optimistically and rolls back on failure", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ ok: false, error: { code: "INTERNAL", message: "boom" } }),
    }) as unknown as typeof globalThis.fetch;

    const store = useConcordStore();
    store.paused = false;

    await store.setPauseState(true);

    expect(store.paused).toBe(false);
    expect(store.error).toBe("boom");
  });

  it("handleFrame updates paused on system.paused_changed", () => {
    const store = useConcordStore();
    store.handleFrame({ type: "system.paused_changed", data: { paused: true } });
    expect(store.paused).toBe(true);
    store.handleFrame({ type: "system.paused_changed", data: { paused: false } });
    expect(store.paused).toBe(false);
  });

  it("replayEvent is idempotent when the response and stream frame carry the same id", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      json: () =>
        Promise.resolve({
          ok: true,
          data: {
            id: "evt-2",
            producerId: "concord.replay",
            producerEventId: "pevt-1#1",
            datetime: "2026-07-05T00:00:00Z",
            type: "foo",
            payload: {},
            muted: false,
          },
        }),
    }) as unknown as typeof globalThis.fetch;

    const store = useConcordStore();
    await store.replayEvent("evt-1");
    expect(store.events).toHaveLength(1);

    store.handleFrame({
      type: "event.created",
      data: store.events[0],
    });
    expect(store.events).toHaveLength(1);
    expect(store.eventsTotal).toBe(1);
  });

  it("abortRun updates the matching run in place", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      json: () =>
        Promise.resolve({
          ok: true,
          data: {
            id: "run-1",
            state: "ABORTED",
            consumerId: "c-1",
            failure: null,
            event: { id: "evt-1", producerId: "p", producerEventId: "p-1", datetime: "", type: "foo", payload: {}, muted: false },
          },
        }),
    }) as unknown as typeof globalThis.fetch;

    const store = useConcordStore();
    store.runs = [
      { id: "run-1", state: "RUNNING", consumerId: "c-1", failure: null, startedAt: null, finishedAt: null, event: { id: "evt-1", producerId: "p", producerEventId: "p-1", datetime: "", type: "foo", payload: {}, muted: false } },
    ];
    store.runsTotal = 1;

    await store.abortRun("run-1");

    expect(store.runs).toHaveLength(1);
    expect(store.runs[0].state).toBe("ABORTED");
    expect(store.runsTotal).toBe(1);
  });

  it("abortRun tracks the in-flight request so the UI can show feedback", async () => {
    let resolveResponse!: (value: unknown) => void;
    globalThis.fetch = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveResponse = resolve;
      }),
    ) as unknown as typeof globalThis.fetch;

    const store = useConcordStore();
    const promise = store.abortRun("run-1");

    expect(store.isAborting("run-1")).toBe(true);

    resolveResponse({
      json: () =>
        Promise.resolve({
          ok: true,
          data: {
            id: "run-1",
            state: "ABORTED",
            consumerId: "c-1",
            failure: null,
            event: { id: "evt-1", producerId: "p", producerEventId: "p-1", datetime: "", type: "foo", payload: {}, muted: false },
          },
        }),
    });
    await promise;

    expect(store.isAborting("run-1")).toBe(false);
    expect(store.abortingIds).toHaveLength(0);
  });

  it("abortRun clears the in-flight flag even when the request fails", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ ok: false, error: { code: "CONFLICT", message: "not abortable" } }),
    }) as unknown as typeof globalThis.fetch;

    const store = useConcordStore();
    await store.abortRun("run-1");

    expect(store.isAborting("run-1")).toBe(false);
    expect(store.error).toBe("not abortable");
  });

  it("restartRun prepends the new run idempotently", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      json: () =>
        Promise.resolve({
          ok: true,
          data: {
            id: "run-2",
            state: "SUCCEEDED",
            consumerId: "c-1",
            failure: null,
            event: { id: "evt-1", producerId: "p", producerEventId: "p-1", datetime: "", type: "foo", payload: {}, muted: false },
          },
        }),
    }) as unknown as typeof globalThis.fetch;

    const store = useConcordStore();
    store.runs = [
      { id: "run-1", state: "SUCCEEDED", consumerId: "c-1", failure: null, startedAt: null, finishedAt: null, event: { id: "evt-1", producerId: "p", producerEventId: "p-1", datetime: "", type: "foo", payload: {}, muted: false } },
    ];
    store.runsTotal = 1;

    await store.restartRun("run-1");

    expect(store.runs).toHaveLength(2);
    expect(store.runs[0].id).toBe("run-2");
    expect(store.runsTotal).toBe(2);

    store.handleFrame({
      type: "run.created",
      data: store.runs[0],
    });
    expect(store.runs).toHaveLength(2);
    expect(store.runsTotal).toBe(2);
  });

  it("restartRun records the new run id so the UI can link to it", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      json: () =>
        Promise.resolve({
          ok: true,
          data: {
            id: "run-2",
            state: "RUNNING",
            consumerId: "c-1",
            failure: null,
            event: { id: "evt-1", producerId: "p", producerEventId: "p-1", datetime: "", type: "foo", payload: {}, muted: false },
          },
        }),
    }) as unknown as typeof globalThis.fetch;

    const store = useConcordStore();

    await store.restartRun("run-1");

    expect(store.restartedAs["run-1"]).toBe("run-2");
  });

  it("restartRun tracks the in-flight request so the UI can show feedback", async () => {
    let resolveResponse!: (value: unknown) => void;
    globalThis.fetch = vi.fn().mockReturnValue(
      new Promise((resolve) => {
        resolveResponse = resolve;
      }),
    ) as unknown as typeof globalThis.fetch;

    const store = useConcordStore();
    const promise = store.restartRun("run-1");

    expect(store.isRestarting("run-1")).toBe(true);

    resolveResponse({
      json: () =>
        Promise.resolve({
          ok: true,
          data: {
            id: "run-2",
            state: "SUCCEEDED",
            consumerId: "c-1",
            failure: null,
            event: { id: "evt-1", producerId: "p", producerEventId: "p-1", datetime: "", type: "foo", payload: {}, muted: false },
          },
        }),
    });
    await promise;

    expect(store.isRestarting("run-1")).toBe(false);
    expect(store.restartingIds).toHaveLength(0);
  });

  it("restartRun clears the in-flight flag even when the request fails", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ ok: false, error: { code: "CONFLICT", message: "not restartable" } }),
    }) as unknown as typeof globalThis.fetch;

    const store = useConcordStore();
    await store.restartRun("run-1");

    expect(store.isRestarting("run-1")).toBe(false);
    expect(store.error).toBe("not restartable");
  });
});

describe("useConcordStore — peak hours", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.restoreAllMocks();
  });

  it("loadPeakHours populates the peakHours ref", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        json: () => Promise.resolve({ ok: true, data: { peakHours: { start: "09:00", end: "17:00", timezone: "UTC" } } }),
      }),
    );

    const store = useConcordStore();
    await store.loadPeakHours();

    expect(store.peakHours).toEqual({ start: "09:00", end: "17:00", timezone: "UTC" });
  });

  it("setPeakHours applies the change optimistically and keeps it on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        json: () => Promise.resolve({ ok: true, data: { peakHours: { start: "10:00", end: "16:00", timezone: "UTC" } } }),
      }),
    );

    const store = useConcordStore();
    store.peakHours = null;

    await store.setPeakHours({ start: "10:00", end: "16:00", timezone: "UTC" });

    expect(store.peakHours).toEqual({ start: "10:00", end: "16:00", timezone: "UTC" });
  });

  it("setPeakHours rolls back on client failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        json: () => Promise.resolve({ ok: false, error: { code: "BAD_REQUEST", message: "bad" } }),
      }),
    );

    const store = useConcordStore();
    store.peakHours = { start: "09:00", end: "17:00", timezone: "UTC" };

    await store.setPeakHours({ start: "10:00", end: "16:00", timezone: "UTC" });

    expect(store.peakHours).toEqual({ start: "09:00", end: "17:00", timezone: "UTC" });
  });

  it("replaces the peakHours ref on the system.peak_hours_changed frame", () => {
    const store = useConcordStore();
    store.peakHours = null;

    store.handleFrame({ type: "system.peak_hours_changed", data: { start: "09:00", end: "17:00", timezone: "UTC" } });

    expect(store.peakHours).toEqual({ start: "09:00", end: "17:00", timezone: "UTC" });

    store.handleFrame({ type: "system.peak_hours_changed", data: null });

    expect(store.peakHours).toBeNull();
  });
});

describe("useConcordStore — consumer config and wait-for-off-peak", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.restoreAllMocks();
  });

  it("setConsumerWaitForOffPeak updates the local consumer optimistically with rollback", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        json: () =>
          Promise.resolve({
            ok: false,
            error: { code: "INTERNAL", message: "boom" },
          }),
      }),
    );

    const store = useConcordStore();
    store.consumers = [
      { id: "c-1", enabled: true, waitForOffPeak: false, configParameters: [], configValues: {}, secretParameters: [], secretNames: [] },
    ];

    await store.setConsumerWaitForOffPeak("c-1", true);

    expect(store.consumers[0].waitForOffPeak).toBe(false);
  });

  it("setConsumerConfig updates the local consumer and rolls back on failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        json: () =>
          Promise.resolve({
            ok: false,
            error: { code: "BAD_REQUEST", message: "bad key" },
          }),
      }),
    );

    const store = useConcordStore();
    store.consumers = [
      { id: "c-1", enabled: true, waitForOffPeak: false, configParameters: [{ key: "modelId", label: "Model", required: true, defaultValue: "" }], configValues: { modelId: "old" }, secretParameters: [], secretNames: [] },
    ];

    await store.setConsumerConfig("c-1", { modelId: "new" });

    expect(store.consumers[0].configValues).toEqual({ modelId: "old" });
  });

  it("setConsumerSecrets optimistically updates secretNames and applies the server response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        json: () =>
          Promise.resolve({
            ok: true,
            data: {
              id: "c-1",
              enabled: true,
              waitForOffPeak: false,
              configParameters: [],
              configValues: {},
              secretParameters: [{ key: "githubToken", label: "GitHub token" }],
              secretNames: ["githubToken"],
            },
          }),
      }),
    );

    const store = useConcordStore();
    store.consumers = [
      { id: "c-1", enabled: true, waitForOffPeak: false, configParameters: [], configValues: {}, secretParameters: [{ key: "githubToken", label: "GitHub token" }], secretNames: [] },
    ];

    await store.setConsumerSecrets("c-1", { upserts: [{ name: "githubToken", value: "tok-1" }], deletes: [] });

    expect(store.consumers[0].secretNames).toEqual(["githubToken"]);
  });

  it("setConsumerSecrets rolls back secretNames on failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        json: () =>
          Promise.resolve({
            ok: false,
            error: { code: "BAD_REQUEST", message: "bad key" },
          }),
      }),
    );

    const store = useConcordStore();
    store.consumers = [
      { id: "c-1", enabled: true, waitForOffPeak: false, configParameters: [], configValues: {}, secretParameters: [{ key: "githubToken", label: "GitHub token" }], secretNames: [] },
    ];

    await store.setConsumerSecrets("c-1", { upserts: [{ name: "githubToken", value: "tok-1" }], deletes: [] });

    expect(store.consumers[0].secretNames).toEqual([]);
  });
});

describe("useConcordStore — run forms", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    setActivePinia(createPinia());
    originalFetch = globalThis.fetch;
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("loadRunForms populates the forms ref keyed by run id", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      json: () =>
        Promise.resolve({
          ok: true,
          data: {
            items: [
              {
                id: "form-1",
                runId: "run-1",
                consumerId: "c-1",
                round: 1,
                status: "PENDING",
                prompt: "Which?",
                context: "",
                fields: [{ key: "note", label: "Note", inputType: "text", defaultValue: "" }],
                answers: null,
                createdAt: "2026-07-06T08:00:00.000Z",
                answeredAt: null,
              },
            ],
          },
        }),
    }) as unknown as typeof globalThis.fetch;

    const store = useConcordStore();
    const result = await store.loadRunForms("run-1");

    expect(result).toHaveLength(1);
    expect(store.forms["run-1"]).toHaveLength(1);
    expect(store.forms["run-1"][0].id).toBe("form-1");
  });

  it("submitRunForm replaces the answered form in the local list and surfaces errors", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      json: () =>
        Promise.resolve({
          ok: true,
          data: {
            id: "form-1",
            runId: "run-1",
            consumerId: "c-1",
            round: 1,
            status: "ANSWERED",
            prompt: "Which?",
            fields: [{ key: "note", label: "Note", inputType: "text", defaultValue: "" }],
            answers: { note: "ok" },
            createdAt: "2026-07-06T08:00:00.000Z",
            answeredAt: "2026-07-06T08:05:00.000Z",
          },
        }),
    }) as unknown as typeof globalThis.fetch;

    const store = useConcordStore();
    store.forms = {
      "run-1": [
        {
          id: "form-1",
          runId: "run-1",
          consumerId: "c-1",
          round: 1,
          status: "PENDING",
          prompt: "Which?",
          context: "",
          fields: [{ key: "note", label: "Note", inputType: "text", defaultValue: "" }],
          answers: null,
          createdAt: "2026-07-06T08:00:00.000Z",
          answeredAt: null,
        },
      ],
    };

    const updated = await store.submitRunForm("run-1", "form-1", { note: "ok" });

    expect(updated?.status).toBe("ANSWERED");
    expect(store.forms["run-1"][0].status).toBe("ANSWERED");
    expect(store.forms["run-1"][0].answers).toEqual({ note: "ok" });
  });

  it("submitRunForm surfaces an error when the server rejects", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      json: () =>
        Promise.resolve({ ok: false, error: { code: "CONFLICT", message: "already answered" } }),
    }) as unknown as typeof globalThis.fetch;

    const store = useConcordStore();

    const result = await store.submitRunForm("run-1", "form-1", { note: "ok" });

    expect(result).toBeUndefined();
    expect(store.error).toBe("already answered");
  });
});

describe("useConcordStore — event templates", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    setActivePinia(createPinia());
    originalFetch = globalThis.fetch;
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("loadEventTemplates populates the eventTemplates ref", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      json: () =>
        Promise.resolve({
          ok: true,
          data: [
            {
              id: "raw-json",
              label: "Raw JSON",
              description: "desc",
              producerId: "web-ui",
              fields: [{ key: "json", label: "JSON", inputType: "textarea", defaultValue: "" }],
            },
          ],
        }),
    }) as unknown as typeof globalThis.fetch;

    const store = useConcordStore();
    await store.loadEventTemplates();

    expect(store.eventTemplates).toHaveLength(1);
    expect(store.eventTemplates[0].id).toBe("raw-json");
  });

  it("emitEventTemplate upserts the created event and returns it", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      json: () =>
        Promise.resolve({
          ok: true,
          data: {
            id: "evt-1",
            producerId: "web-ui",
            producerEventId: "pevt-1",
            datetime: "2026-07-08T10:00:00Z",
            type: "rawjson",
            payload: { eventId: "pevt-1" },
            muted: false,
          },
        }),
    }) as unknown as typeof globalThis.fetch;

    const store = useConcordStore();
    const result = await store.emitEventTemplate("raw-json", { json: '{"eventId":"pevt-1"}' });

    expect(result?.id).toBe("evt-1");
    expect(store.events).toHaveLength(1);
    expect(store.events[0].type).toBe("rawjson");
  });

  it("emitEventTemplate surfaces an error when the server rejects", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      json: () =>
        Promise.resolve({ ok: false, error: { code: "BAD_REQUEST", message: "invalid JSON" } }),
    }) as unknown as typeof globalThis.fetch;

    const store = useConcordStore();
    const result = await store.emitEventTemplate("raw-json", { json: "bad" });

    expect(result).toBeUndefined();
    expect(store.error).toBe("invalid JSON");
  });
});

describe("useConcordStore — widgets", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    setActivePinia(createPinia());
    originalFetch = globalThis.fetch;
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("loadWidgets populates the widgets ref from the items envelope", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      json: () =>
        Promise.resolve({
          ok: true,
          data: {
            items: [
              { id: "status-widget", kind: "status-panel", refresh: { variant: "interval", intervalMs: 15000 } },
              { id: "static-thing", kind: "static-thing", refresh: { variant: "static" } },
            ],
          },
        }),
    }) as unknown as typeof globalThis.fetch;

    const store = useConcordStore();
    await store.loadWidgets();

    expect(store.widgets).toHaveLength(2);
    expect(store.widgets[0].id).toBe("status-widget");
    expect(store.widgets[0].refresh).toEqual({ variant: "interval", intervalMs: 15000 });
    expect(store.widgets[1].refresh).toEqual({ variant: "static" });
  });

  it("loadWidgets surfaces an error when the server rejects", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ ok: false, error: { code: "INTERNAL", message: "boom" } }),
    }) as unknown as typeof globalThis.fetch;

    const store = useConcordStore();
    await store.loadWidgets();

    expect(store.widgets).toHaveLength(0);
    expect(store.error).toBe("boom");
  });
});

describe("useConcordStore — run activity", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.restoreAllMocks();
  });

  function makeActivityFrame(runId: string, kind: string, at: string, payload: Record<string, unknown> = {}): StreamFrame<RunActivityFrame> {
    return {
      type: "run.activity",
      data: {
        runId,
        consumerId: "c-1",
        sessionId: "sess-1",
        kind,
        payload,
        at,
      },
    };
  }

  function textPartFrame(runId: string, partId: string, delta: string, at: string): StreamFrame<RunActivityFrame> {
    return makeActivityFrame(runId, "message.part.updated", at, {
      part: { sessionID: "sess-1", id: partId, type: "text" },
      delta,
    });
  }

  it("reduces run.activity frames into activity items keyed by run id", () => {
    const store = useConcordStore();

    store.handleFrame(textPartFrame("run-1", "p-1", "hello ", "t1"));
    store.handleFrame(textPartFrame("run-1", "p-1", "world", "t2"));
    store.handleFrame(textPartFrame("run-2", "p-1", "other", "t3"));

    expect(store.activityItems["run-1"]).toHaveLength(1);
    expect((store.activityItems["run-1"][0] as { text: string }).text).toBe("hello world");
    expect(store.activityItems["run-2"]).toHaveLength(1);
  });

  it("feeds a run.update frame into the reducer and appends to the updates cache", () => {
    const store = useConcordStore();

    store.handleFrame(textPartFrame("run-1", "p-1", "working", "t1"));
    store.handleFrame({
      type: "run.update",
      data: {
        runId: "run-1",
        consumerId: "c-1",
        sessionId: "sess-1",
        kind: "run.update",
        payload: { message: "Halfway done.", updateId: "update-9" },
        at: "t2",
      },
    });

    const items = store.activityItems["run-1"];
    expect(items.map((i) => i.itemType)).toEqual(["text", "run-update"]);
    expect(store.runUpdates["run-1"]).toEqual([
      { id: "update-9", runId: "run-1", consumerId: "", message: "Halfway done.", createdAt: "t2" },
    ]);
  });

  it("clearActivity removes the reduced items for a given run id", () => {
    const store = useConcordStore();
    store.handleFrame(textPartFrame("run-clear", "p-1", "hi", "t1"));
    expect(store.activityItems["run-clear"]).toHaveLength(1);

    store.clearActivity("run-clear");
    expect(store.activityItems["run-clear"]).toBeUndefined();
  });
});

