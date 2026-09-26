export interface WidgetPayload {
  readonly kind: string;
}

export type WidgetRefresh =
  | { readonly variant: "interval"; readonly intervalMs: number }
  | { readonly variant: "static" };

export interface WidgetDescriptor {
  readonly id: string;
  readonly kind: string;
  readonly refresh: WidgetRefresh;
}

export interface Widget<TPayload> {
  readonly id: string;
  readonly kind: string;
  readonly refresh: WidgetRefresh;
  render(): Promise<TPayload>;
}
