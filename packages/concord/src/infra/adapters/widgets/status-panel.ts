import type { WidgetPayload } from "./widget";

/** Payload kind rendered by the generic status-panel renderer every
 * Concord UI ships. Deployments describe a status as a title, an optional
 * timestamp line, an optional errored state, and an ordered list of items
 * whose statuses map to fixed badges — enough to express dashboards like a
 * pipeline stage overview without any deployment-specific UI code. */
export const STATUS_PANEL_KIND = "status-panel";

export type StatusPanelItemStatus = "success" | "failed" | "in-progress";

export interface StatusPanelItem {
  readonly label: string;
  readonly status: StatusPanelItemStatus;
  /** Absolute or relative URL rendered as a link on the item's row. */
  readonly link?: string;
}

export type StatusPanelState =
  | { readonly kind: "available" }
  | { readonly kind: "errored"; readonly message: string };

export interface StatusPanelPayload extends WidgetPayload {
  readonly kind: typeof STATUS_PANEL_KIND;
  readonly title: string;
  /** Free-form timestamp line (ISO or preformatted); rendered as-is. */
  readonly timestamp?: string;
  readonly state: StatusPanelState;
  readonly items: readonly StatusPanelItem[];
}
