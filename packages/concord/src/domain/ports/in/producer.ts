import type { EventSink } from "./event-sink";
import type { Registrable } from "./registrable";

export interface Producer extends Registrable {
  readonly producerId: string;
  start(sink: EventSink): Promise<void>;
  stop(): Promise<void>;
}
