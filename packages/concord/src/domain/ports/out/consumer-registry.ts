import type { Consumer } from "../../entities/consumer";

export interface ConsumerRegistry {
  all(): Consumer<unknown>[];
}
