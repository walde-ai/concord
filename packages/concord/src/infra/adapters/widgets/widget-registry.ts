import { WidgetNotFoundError } from "./widget-not-found-error";
import type { Widget, WidgetDescriptor, WidgetPayload } from "./widget";

export interface WidgetRegistry {
  register(widget: Widget<WidgetPayload>): void;
  list(): readonly WidgetDescriptor[];
  render(id: string): Promise<WidgetPayload>;
}

export class InMemoryWidgetRegistry implements WidgetRegistry {
  private readonly widgets: Map<string, Widget<WidgetPayload>> = new Map();
  private readonly order: string[] = [];

  public register(widget: Widget<WidgetPayload>): void {
    if (!this.widgets.has(widget.id)) {
      this.order.push(widget.id);
    }
    this.widgets.set(widget.id, widget);
  }

  public list(): readonly WidgetDescriptor[] {
    return this.order.map((id) => this.toDescriptor(this.widgets.get(id) as Widget<WidgetPayload>));
  }

  public async render(id: string): Promise<WidgetPayload> {
    const widget = this.widgets.get(id);
    if (widget === undefined) {
      throw new WidgetNotFoundError(id);
    }
    return widget.render();
  }

  private toDescriptor(widget: Widget<WidgetPayload>): WidgetDescriptor {
    return { id: widget.id, kind: widget.kind, refresh: widget.refresh };
  }
}
