import { ConcordError } from "../../../domain/exceptions/errors";

export class WidgetNotFoundError extends ConcordError {
  public constructor(public readonly widgetId: string) {
    super(`Widget not found: ${widgetId}`);
  }
}
