import type { ConsumerConfigResolver } from "../../../domain/ports/out/consumer-config-resolver";
import type { RunTimeoutResolver } from "../../../domain/ports/out/run-timeout-resolver";
import { DEFAULT_RUN_TIMEOUT_MS } from "../../../domain/ports/out/run-timeout-resolver";

const RUN_TIMEOUT_MS_KEY = "runTimeoutMs";

/**
 * Resolves a consumer's run timeout from its declared config values. Consumers
 * that declare a `runTimeoutMs` config parameter (the agent consumers) drive
 * the effective timeout; any other consumer, or an unparseable/missing value,
 * falls back to {@link DEFAULT_RUN_TIMEOUT_MS} so every run is still bounded.
 */
export class ConfigRunTimeoutResolver implements RunTimeoutResolver {
  public constructor(
    private readonly configResolver: ConsumerConfigResolver,
    private readonly defaultTimeoutMs: number,
  ) {}

  public async resolve(consumerId: string): Promise<number> {
    const values = await this.configResolver.resolve(consumerId);
    const raw = values[RUN_TIMEOUT_MS_KEY];
    if (raw === undefined || raw.length === 0) {
      return this.defaultTimeoutMs;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return this.defaultTimeoutMs;
    }
    return parsed;
  }
}

export { DEFAULT_RUN_TIMEOUT_MS, RUN_TIMEOUT_MS_KEY };
