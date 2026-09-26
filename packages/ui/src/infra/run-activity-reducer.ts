import type { RunActivityFrame } from "./types";

// Rolling window of reduced activity items kept per run. Older items scroll out
// once exceeded so a long agent run cannot accumulate unbounded rendered state.
export const ACTIVITY_MAX_ITEMS = 500;

// Cap applied to a single accumulated text paragraph (UTF-8 bytes). One
// pathological message cannot dominate memory or the DOM; the paragraph is
// truncated with a visible marker once this is exceeded.
export const ACTIVITY_MAX_PARAGRAPH_BYTES = 65536;

const TRUNCATION_MARKER = " […truncated]";

export type ActivityItem =
  | { itemType: "text"; key: string; text: string; at: string }
  | {
      itemType: "tool";
      key: string;
      toolName: string;
      status: string;
      input: unknown;
      output: string | null;
      error: string | null;
      at: string;
    }
  | { itemType: "reasoning"; key: string; text: string; at: string }
  | { itemType: "part-summary"; key: string; partType: string; summary: string; at: string }
  | { itemType: "session-status"; key: string; label: string; at: string }
  | { itemType: "event-line"; key: string; label: string; at: string }
  | { itemType: "run-update"; key: string; updateId: string; message: string; at: string };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function utf8ByteLength(text: string): number {
  return encoder.encode(text).length;
}

// Longest prefix of `text` whose UTF-8 encoding fits in `maxBytes`, never
// splitting a multibyte character.
function truncateToUtf8Bytes(text: string, maxBytes: number): string {
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) {
    return text;
  }
  let cut = maxBytes;
  while (cut > 0 && (bytes[cut] & 0xc0) === 0x80) {
    cut -= 1;
  }
  return decoder.decode(bytes.subarray(0, cut));
}

function extractStatusLabel(status: unknown): string {
  if (typeof status === "object" && status !== null) {
    const type = (status as { type?: unknown }).type;
    if (typeof type === "string") {
      if (type === "busy") return "busy";
      if (type === "idle") return "idle";
      if (type === "retry") return "retrying";
      return type;
    }
  }
  return "unknown";
}

function summarizePartType(partType: string, part: Record<string, unknown>): string {
  switch (partType) {
    case "step-start":
      return "Step started";
    case "step-finish":
      return "Step finished";
    case "file":
      return "File referenced";
    case "snapshot":
      return "Snapshot";
    case "patch":
      return "Patch applied";
    case "agent":
      return `Agent: ${typeof part.name === "string" ? part.name : "?"}`;
    case "retry":
      return `Retry (attempt ${typeof part.attempt === "number" ? part.attempt : "?"})`;
    case "compaction":
      return "Context compacted";
    case "subtask":
      return `Subtask: ${typeof part.description === "string" ? part.description : ""}`;
    default:
      return partType;
  }
}

function eventLineLabel(kind: string, payload: Record<string, unknown>): string {
  switch (kind) {
    case "file.edited":
      return `File edited: ${payload.file ?? "?"}`;
    case "todo.updated":
      return "Todos updated";
    case "permission.updated":
      return "Permission requested";
    case "command.executed":
      return `Command: ${payload.name ?? "?"}`;
    case "session.compacted":
      return "Session compacted";
    case "session.error":
      return "Session error";
    case "session.created":
      return "Session created";
    case "message.updated":
      return "Message updated";
    case "message.removed":
      return "Message removed";
    default:
      return kind;
  }
}

// Stateful reducer that folds activity frames into an ordered list of rendered
// items. Consecutive text deltas chain into one paragraph; a tool part, a
// reasoning part, a step-start boundary, or a text part with a new id closes the
// paragraph. Tool cards update in place by callID. The list is pruned to
// ACTIVITY_MAX_ITEMS (oldest dropped) and a single paragraph is byte-capped.
export class RunActivityReducer {
  private readonly orderedKeys: string[] = [];
  private readonly itemByKey: Map<string, ActivityItem> = new Map();
  private readonly textAccumulator: Map<string, string> = new Map();
  private readonly textByteLength: Map<string, number> = new Map();
  private readonly truncatedTextKeys: Set<string> = new Set();
  private openTextKey: string | null = null;
  private openTextPartId: string | null = null;
  private counter = 0;

  public push(frame: RunActivityFrame): void {
    if (frame.kind === "run.update") {
      this.closeOpenParagraph();
      const payload = frame.payload as { message?: unknown; updateId?: unknown };
      this.append({
        itemType: "run-update",
        key: `update-${this.nextId()}`,
        updateId: typeof payload.updateId === "string" ? payload.updateId : "",
        message: typeof payload.message === "string" ? payload.message : "",
        at: frame.at,
      });
      return;
    }

    if (frame.kind === "message.part.updated") {
      const part = partFromFrame(frame);
      if (part === undefined) {
        return;
      }
      const partType = typeof part.type === "string" ? part.type : "unknown";
      const partId = typeof part.id === "string" ? part.id : `${frame.kind}-${frame.at}`;

      if (partType === "text") {
        const delta = frame.payload.delta;
        const fullText = typeof part.text === "string" ? part.text : "";
        this.pushTextDelta(partId, delta, fullText, frame.at);
        return;
      }

      // A tool, reasoning, or any non-text part closes the open paragraph.
      this.closeOpenParagraph();

      if (partType === "tool") {
        const callID = typeof part.callID === "string" ? part.callID : partId;
        const toolKey = `tool-${callID}`;
        const state = (part.state ?? {}) as Record<string, unknown>;
        this.upsert({
          itemType: "tool",
          key: toolKey,
          toolName: typeof part.tool === "string" ? part.tool : "unknown",
          status: typeof state.status === "string" ? state.status : "unknown",
          input: state.input ?? {},
          output: typeof state.output === "string" ? state.output : null,
          error: typeof state.error === "string" ? state.error : null,
          at: frame.at,
        });
        return;
      }

      if (partType === "reasoning") {
        this.upsert({
          itemType: "reasoning",
          key: `reasoning-${partId}`,
          text: typeof part.text === "string" ? part.text : "",
          at: frame.at,
        });
        return;
      }

      this.append({
        itemType: "part-summary",
        key: `part-${partId}-${this.nextId()}`,
        partType,
        summary: summarizePartType(partType, part),
        at: frame.at,
      });
      return;
    }

    if (frame.kind === "session.status" || frame.kind === "session.idle") {
      this.closeOpenParagraph();
      const label =
        frame.kind === "session.idle"
          ? "idle"
          : extractStatusLabel((frame.payload as { status?: unknown }).status);
      this.append({
        itemType: "session-status",
        key: `status-${this.nextId()}`,
        label,
        at: frame.at,
      });
      return;
    }

    this.closeOpenParagraph();
    this.append({
      itemType: "event-line",
      key: `event-${this.nextId()}`,
      label: eventLineLabel(frame.kind, frame.payload),
      at: frame.at,
    });
  }

  public getItems(): ActivityItem[] {
    const result: ActivityItem[] = [];
    for (const key of this.orderedKeys) {
      const item = this.itemByKey.get(key);
      if (item !== undefined) {
        result.push(item);
      }
    }
    return result;
  }

  public clear(): void {
    this.orderedKeys.length = 0;
    this.itemByKey.clear();
    this.textAccumulator.clear();
    this.textByteLength.clear();
    this.truncatedTextKeys.clear();
    this.openTextKey = null;
    this.openTextPartId = null;
  }

  private nextId(): number {
    this.counter += 1;
    return this.counter;
  }

  private pushTextDelta(partId: string, delta: unknown, fullText: string, at: string): void {
    // A text part with a new id closes the currently open paragraph before a
    // new one opens. Same id as the open paragraph continues to chain into it.
    if (this.openTextPartId !== partId) {
      this.closeOpenParagraph();
      const key = `text-${this.nextId()}`;
      this.openTextKey = key;
      this.openTextPartId = partId;
      this.textAccumulator.set(key, "");
      this.textByteLength.set(key, 0);
    }
    const key = this.openTextKey!;
    if (this.truncatedTextKeys.has(key)) {
      return;
    }

    let acc = this.textAccumulator.get(key) ?? "";
    let bytes = this.textByteLength.get(key) ?? 0;
    if (typeof delta === "string") {
      acc += delta;
      bytes += utf8ByteLength(delta);
    } else {
      acc = fullText;
      bytes = utf8ByteLength(acc);
    }

    if (bytes > ACTIVITY_MAX_PARAGRAPH_BYTES) {
      acc = truncateToUtf8Bytes(acc, ACTIVITY_MAX_PARAGRAPH_BYTES) + TRUNCATION_MARKER;
      this.truncatedTextKeys.add(key);
    }

    this.textAccumulator.set(key, acc);
    this.textByteLength.set(key, bytes);
    this.upsert({ itemType: "text", key, text: acc, at });
  }

  private closeOpenParagraph(): void {
    this.openTextKey = null;
    this.openTextPartId = null;
  }

  // Update an existing item in place (preserving its position) when its key is
  // already tracked; otherwise append a new item at the end.
  private upsert(item: ActivityItem): void {
    if (this.itemByKey.has(item.key)) {
      this.itemByKey.set(item.key, item);
      return;
    }
    this.orderedKeys.push(item.key);
    this.itemByKey.set(item.key, item);
    this.prune();
  }

  // Append an item whose key is always new (status markers, event lines,
  // summaries, run updates). Distinct keys keep each entry its own block.
  private append(item: ActivityItem): void {
    this.orderedKeys.push(item.key);
    this.itemByKey.set(item.key, item);
    this.prune();
  }

  private prune(): void {
    while (this.orderedKeys.length > ACTIVITY_MAX_ITEMS) {
      const droppedKey = this.orderedKeys.shift() as string;
      this.itemByKey.delete(droppedKey);
      this.textAccumulator.delete(droppedKey);
      this.textByteLength.delete(droppedKey);
      this.truncatedTextKeys.delete(droppedKey);
    }
  }
}

function partFromFrame(frame: RunActivityFrame): Record<string, unknown> | undefined {
  const part = (frame.payload as { part?: unknown }).part;
  if (typeof part === "object" && part !== null) {
    return part as Record<string, unknown>;
  }
  return undefined;
}
