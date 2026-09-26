import type { Producer } from "../../domain/ports/in/producer";
import type { EventSink } from "../../domain/ports/in/event-sink";
import type { Registrable } from "../../domain/ports/in/registrable";
import type { EventTemplate } from "../../domain/ports/in/event-template";
import type { RequestRunInput } from "../../domain/ports/in/request-run-input";
import type { SubmitRunInput } from "../../domain/ports/in/submit-run-input";
import type { RecordRunUpdate } from "../../domain/ports/in/record-run-update";
import type { IdGenerator } from "../../domain/ports/out/id-generator";
import type { Clock } from "../../domain/ports/out/clock";
import type { RunRepository } from "../../domain/ports/out/run-repository";
import type { FormRepository } from "../../domain/ports/out/form-repository";
import type { EventLifecycleObserver } from "../../domain/ports/out/event-lifecycle-observer";
import type { ConsumerRegistry } from "../../domain/ports/out/consumer-registry";
import type { ConsumerStateRepository } from "../../domain/ports/out/consumer-state-repository";
import type { ContextResolver } from "../../domain/ports/out/context-resolver";
import type { ConsumerConfigResolver } from "../../domain/ports/out/consumer-config-resolver";
import type { ConsumerSecretResolver } from "../../domain/ports/out/consumer-secret-resolver";
import type { Logger } from "../../domain/ports/out/logger";
import type { RunActivityEmitter } from "../adapters/opencode/run-activity-emitter";
import type { WidgetRegistry } from "../adapters/widgets/widget-registry";
import type { PullRequestLifecycleStore } from "../adapters/producers/github/pull-request-lifecycle-store";
import type { WorktreeLeases } from "../adapters/git/worktree-lease-registry";
import { RunDispatcher } from "../../domain/interactors/run-dispatcher";
import { InterruptedRunReconciler } from "../../domain/interactors/interrupted-run-reconciler";
import { InMemoryConsumerRegistry } from "../adapters/registry/in-memory-consumer-registry";
import type { InMemoryProducerRegistry } from "../adapters/registry/in-memory-producer-registry";
import type { InMemoryEventTemplateRegistry } from "../adapters/registry/in-memory-event-template-registry";
import type { Closeable } from "./closeable";
import type { Startable } from "./startable";
import { RegistrationContext } from "./registration-context";

export class App {
  private readonly producers: Producer[] = [];
  private readonly interruptedRunReconciler: InterruptedRunReconciler;

  public constructor(
    private readonly eventSink: EventSink,
    public readonly registry: InMemoryConsumerRegistry,
    public readonly producerRegistry: InMemoryProducerRegistry,
    public readonly eventTemplateRegistry: InMemoryEventTemplateRegistry,
    private readonly idGenerator: IdGenerator,
    private readonly clock: Clock,
    public readonly contexts: ContextResolver,
    public readonly consumerConfigResolver: ConsumerConfigResolver,
    public readonly consumerSecretResolver: ConsumerSecretResolver,
    public readonly runRepository: RunRepository,
    observer: EventLifecycleObserver,
    public readonly logger: Logger,
    public readonly requestRunInput: RequestRunInput,
    public readonly recordRunUpdate: RecordRunUpdate,
    public readonly submitRunInput: SubmitRunInput,
    public readonly formRepository: FormRepository,
    public readonly runActivityEmitter: RunActivityEmitter,
    public readonly widgetRegistry: WidgetRegistry,
    private readonly runDispatcher: RunDispatcher,
    private readonly closeables: Closeable[] = [],
    private readonly startables: Startable[] = [],
    public readonly pullRequestLifecycleStore: PullRequestLifecycleStore,
    consumerStateRepository: ConsumerStateRepository,
    public readonly worktreeLeases: WorktreeLeases,
  ) {
    this.interruptedRunReconciler = new InterruptedRunReconciler(
      runRepository,
      observer,
      clock,
      registry,
      consumerStateRepository,
      runDispatcher,
      logger,
    );
  }

  public register(registrable: Registrable): void {
    const context = new RegistrationContext(this.idGenerator, this.clock, this.contexts);
    registrable.register(context);
    for (const producer of context.producers) {
      this.producers.push(producer);
      this.producerRegistry.register({ producerId: producer.producerId, disableable: true });
    }
    for (const consumer of context.consumers) {
      this.registry.register(consumer);
    }
    for (const template of context.eventTemplates) {
      this.eventTemplateRegistry.register(template);
    }
  }

  public async start(): Promise<void> {
    await this.interruptedRunReconciler.reconcile();
    // Bind the HTTP server (and the rest of the startables) BEFORE starting
    // producers. A producer's first poll can emit an event whose dispatch
    // SignalEventInteractor awaits to completion; if that consumer run is slow
    // (an agent run, or one stuck in a retry loop) and the HTTP server has not
    // bound yet, the API — and login — stays down until the run finishes.
    // Binding first keeps the API reachable no matter how long a
    // producer-triggered run takes.
    await Promise.allSettled(this.startables.map((service) => service.start()));
    const producerResults = await Promise.allSettled(
      this.producers.map((producer) => producer.start(this.eventSink)),
    );
    const producerErrors = producerResults
      .filter((r): r is PromiseRejectedResult => r.status === "rejected");
    for (const result of producerErrors) {
      this.logger.error("concord-app", "producer failed to start", {
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });
    }
  }

  public async stop(): Promise<void> {
    await Promise.allSettled(this.producers.map((producer) => producer.stop()));
    await Promise.allSettled(this.closeables.map((resource) => resource.close()));
  }

  // Awaits all in-flight detached runs, including any that are spawned
  // transitively by their handlers (a detached run's handler may emit events
  // that dispatch further detached runs). Useful for tests that emit an event
  // synchronously and then need to assert state produced by downstream runs
  // triggered from within the handler.
  //
  // Deliberately NOT called from stop(): a stuck run (the failure mode this
  // fix exists to recover from) would make shutdown hang until systemd's
  // TimeoutStopSec force-kills the process. InterruptedRunReconciler already
  // transitions in-flight runs to FAILED on the next startup, so a hard stop
  // is recovered automatically.
  public async awaitRuns(): Promise<void> {
    await this.runDispatcher.awaitDetached();
  }
}
