import type { Run } from "../entities/run";
import type { RestartRun } from "../ports/in/restart-run";
import type { RunRepository } from "../ports/out/run-repository";
import type { ConsumerRegistry } from "../ports/out/consumer-registry";
import type { ConsumerStateRepository } from "../ports/out/consumer-state-repository";
import type { RunDispatcher } from "./run-dispatcher";
import { RunNotRestartableError, ConsumerNotFoundError, ConsumerDisabledError } from "../exceptions/errors";

export class RestartRunInteractor implements RestartRun {
  public constructor(
    private readonly runRepository: RunRepository,
    private readonly consumerRegistry: ConsumerRegistry,
    private readonly consumerStateRepository: ConsumerStateRepository,
    private readonly runDispatcher: RunDispatcher,
  ) {}

  public async restart(runId: string): Promise<Run<unknown>> {
    const source = await this.runRepository.getById(runId);
    if (source.state === "RUNNING" || source.state === "PENDING_INPUT") {
      throw new RunNotRestartableError(runId, source.state);
    }
    const consumer = this.consumerRegistry
      .all()
      .find((entry) => entry.consumerId === source.consumerId);
    if (consumer === undefined) {
      throw new ConsumerNotFoundError(source.consumerId);
    }
    const enabled = await this.consumerStateRepository.get(consumer.consumerId);
    if (!enabled) {
      throw new ConsumerDisabledError(consumer.consumerId);
    }
    return this.runDispatcher.dispatchDetached(source.event, consumer);
  }
}
