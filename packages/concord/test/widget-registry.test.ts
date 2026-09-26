import { describe, it, expect } from "vitest";

import { InMemoryWidgetRegistry } from "../src/infra/adapters/widgets/widget-registry";
import { WidgetNotFoundError } from "../src/infra/adapters/widgets/widget-not-found-error";
import type { Widget, WidgetPayload, WidgetRefresh } from "../src/infra/adapters/widgets/widget";

interface FakePayload extends WidgetPayload {
  readonly kind: "fake";
  readonly message: string;
}

class FakeWidget implements Widget<FakePayload> {
  public constructor(
    public readonly id: string,
    public readonly kind: string,
    public readonly refresh: WidgetRefresh,
    private readonly payload: FakePayload,
  ) {}

  public async render(): Promise<FakePayload> {
    return this.payload;
  }
}

describe("InMemoryWidgetRegistry", () => {
  it("exposes a descriptor per registered widget in insertion order", () => {
    const registry = new InMemoryWidgetRegistry();
    const interval = { variant: "interval", intervalMs: 15000 } as const;
    const widget = new FakeWidget("pipeline-status", "pipeline-status", interval, {
      kind: "fake",
      message: "hi",
    });

    registry.register(widget);

    const descriptors = registry.list();
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]).toEqual({ id: "pipeline-status", kind: "pipeline-status", refresh: interval });
  });

  it("preserves insertion order and lets the last write win for a duplicate id", () => {
    const registry = new InMemoryWidgetRegistry();
    const first = new FakeWidget("a", "fake", { variant: "static" }, { kind: "fake", message: "1" });
    const second = new FakeWidget("b", "fake", { variant: "static" }, { kind: "fake", message: "2" });
    const replacement = new FakeWidget("a", "fake", { variant: "interval", intervalMs: 1000 }, { kind: "fake", message: "3" });

    registry.register(first);
    registry.register(second);
    registry.register(replacement);

    const descriptors = registry.list();
    expect(descriptors.map((d) => d.id)).toEqual(["a", "b"]);
    expect(descriptors[0].refresh).toEqual({ variant: "interval", intervalMs: 1000 });
  });

  it("renders the payload produced by the matching widget", async () => {
    const registry = new InMemoryWidgetRegistry();
    const payload: FakePayload = { kind: "fake", message: "hello" };
    registry.register(new FakeWidget("a", "fake", { variant: "static" }, payload));

    const rendered = await registry.render("a");

    expect(rendered).toBe(payload);
  });

  it("throws WidgetNotFoundError when no widget is registered for the id", async () => {
    const registry = new InMemoryWidgetRegistry();

    await expect(registry.render("missing")).rejects.toBeInstanceOf(WidgetNotFoundError);
  });
});
