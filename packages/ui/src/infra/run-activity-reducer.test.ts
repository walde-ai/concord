import { describe, it, expect } from "vitest";

import {
  RunActivityReducer,
  ACTIVITY_MAX_ITEMS,
  ACTIVITY_MAX_PARAGRAPH_BYTES,
} from "./run-activity-reducer";
import type { RunActivityFrame } from "./types";

function textFrame(partId: string, delta: string | undefined, text: string | undefined, at: string): RunActivityFrame {
  return {
    runId: "run-1",
    consumerId: "c-1",
    sessionId: "sess-1",
    kind: "message.part.updated",
    payload: { part: { sessionID: "sess-1", id: partId, type: "text", text }, delta },
    at,
  };
}

function toolFrame(callID: string, status: string, at: string, overrides: Record<string, unknown> = {}): RunActivityFrame {
  return {
    runId: "run-1",
    consumerId: "c-1",
    sessionId: "sess-1",
    kind: "message.part.updated",
    payload: {
      part: {
        sessionID: "sess-1",
        id: `part-${callID}`,
        type: "tool",
        tool: "bash",
        callID,
        state: { status, ...overrides },
      },
    },
    at,
  };
}

function reasoningFrame(partId: string, text: string, at: string): RunActivityFrame {
  return {
    runId: "run-1",
    consumerId: "c-1",
    sessionId: "sess-1",
    kind: "message.part.updated",
    payload: { part: { sessionID: "sess-1", id: partId, type: "reasoning", text } },
    at,
  };
}

function runUpdateFrame(updateId: string, message: string, at: string): RunActivityFrame {
  return {
    runId: "run-1",
    consumerId: "c-1",
    sessionId: "sess-1",
    kind: "run.update",
    payload: { message, updateId },
    at,
  };
}

describe("RunActivityReducer — paragraph grouping", () => {
  it("chains consecutive text deltas for one part id into a single paragraph", () => {
    const reducer = new RunActivityReducer();
    reducer.push(textFrame("p-1", "hel", undefined, "t1"));
    reducer.push(textFrame("p-1", "lo", undefined, "t2"));
    reducer.push(textFrame("p-1", " world", undefined, "t3"));

    const items = reducer.getItems();
    expect(items).toHaveLength(1);
    expect(items[0].itemType).toBe("text");
    expect((items[0] as { text: string }).text).toBe("hello world");
  });

  it("closes the paragraph and starts a new block when a tool part arrives, then reopens for further text", () => {
    const reducer = new RunActivityReducer();
    reducer.push(textFrame("p-1", "first", undefined, "t1"));
    reducer.push(toolFrame("call-1", "running", "t2"));
    reducer.push(textFrame("p-1", "second", undefined, "t3"));

    const items = reducer.getItems();
    expect(items.map((i) => i.itemType)).toEqual(["text", "tool", "text"]);
    expect((items[2] as { text: string }).text).toBe("second");
  });

  it("closes the paragraph when a reasoning part arrives", () => {
    const reducer = new RunActivityReducer();
    reducer.push(textFrame("p-1", "before", undefined, "t1"));
    reducer.push(reasoningFrame("r-1", "thinking", "t2"));
    reducer.push(textFrame("p-1", "after", undefined, "t3"));

    const items = reducer.getItems();
    expect(items.map((i) => i.itemType)).toEqual(["text", "reasoning", "text"]);
  });

  it("closes the paragraph when a text part with a new id arrives", () => {
    const reducer = new RunActivityReducer();
    reducer.push(textFrame("p-1", "turn1", undefined, "t1"));
    reducer.push(textFrame("p-2", "turn2", undefined, "t2"));

    const items = reducer.getItems();
    expect(items).toHaveLength(2);
    expect((items[0] as { text: string }).text).toBe("turn1");
    expect((items[1] as { text: string }).text).toBe("turn2");
  });

  it("updates a tool card in place by callID", () => {
    const reducer = new RunActivityReducer();
    reducer.push(toolFrame("call-1", "running", "t1"));
    reducer.push(toolFrame("call-1", "completed", "t2", { output: "done" }));

    const items = reducer.getItems();
    expect(items).toHaveLength(1);
    const tool = items[0] as { itemType: "tool"; status: string; output: string | null };
    expect(tool.status).toBe("completed");
    expect(tool.output).toBe("done");
  });

  it("falls back to the full part text when no delta is present", () => {
    const reducer = new RunActivityReducer();
    reducer.push(textFrame("p-1", undefined, "whole message", "t1"));

    const items = reducer.getItems();
    expect((items[0] as { text: string }).text).toBe("whole message");
  });
});

describe("RunActivityReducer — run.update blocks", () => {
  it("turns a run.update frame into its own markdown item", () => {
    const reducer = new RunActivityReducer();
    reducer.push(textFrame("p-1", "working", undefined, "t1"));
    reducer.push(runUpdateFrame("update-9", "Halfway done.", "t2"));

    const items = reducer.getItems();
    expect(items.map((i) => i.itemType)).toEqual(["text", "run-update"]);
    const update = items[1] as { itemType: "run-update"; updateId: string; message: string };
    expect(update.updateId).toBe("update-9");
    expect(update.message).toBe("Halfway done.");
  });
});

describe("RunActivityReducer — pruning and caps", () => {
  it("keeps at most ACTIVITY_MAX_ITEMS items, dropping the oldest", () => {
    const reducer = new RunActivityReducer();
    for (let i = 0; i < ACTIVITY_MAX_ITEMS + 5; i++) {
      reducer.push(runUpdateFrame(`u-${i}`, `update ${i}`, `t${i}`));
    }
    const items = reducer.getItems();
    expect(items).toHaveLength(ACTIVITY_MAX_ITEMS);
    const first = items[0] as { itemType: "run-update"; updateId: string };
    expect(first.updateId).toBe("u-5");
  });

  it("truncates a single accumulated paragraph at ACTIVITY_MAX_PARAGRAPH_BYTES with a visible marker", () => {
    const reducer = new RunActivityReducer();
    const chunk = "x".repeat(10_000);
    for (let i = 0; i < 10; i++) {
      reducer.push(textFrame("p-1", chunk, undefined, `t${i}`));
    }
    const items = reducer.getItems();
    expect(items).toHaveLength(1);
    const text = (items[0] as { text: string }).text;
    expect(text.endsWith("[…truncated]")).toBe(true);
    // The visible (non-marker) portion fits under the byte cap.
    const visible = text.slice(0, text.length - " […truncated]".length);
    expect(new TextEncoder().encode(visible).length).toBeLessThanOrEqual(ACTIVITY_MAX_PARAGRAPH_BYTES);
  });
});
