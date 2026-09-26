import type { ContextStore } from "../../../domain/ports/out/context-store";
import type { ContextResolver, ContextRequester, ContextGuard, ResolvedContext } from "../../../domain/ports/out/context-resolver";
import type { EventSink } from "../../../domain/ports/in/event-sink";
import type { IdGenerator } from "../../../domain/ports/out/id-generator";
import type { Clock } from "../../../domain/ports/out/clock";
import type { Result } from "../../../domain/result";
import { success, failure } from "../../../domain/result";
import type { ContextResolveError } from "../../../domain/exceptions/errors";
import { ContextResolveError as ContextResolveErrorClass } from "../../../domain/exceptions/errors";
import { Event } from "../../../domain/entities/event";

export const ERROR_CONTEXT = "error.context";
export const CONCORD_PRODUCER_ID = "concord";

interface ErrorContextPayload {
  readonly requesterKind: "producer" | "consumer";
  readonly requesterId: string;
  readonly contextName: string;
  readonly reason: "NOT_FOUND" | "INVALID_SHAPE";
}

export class EventEmittingContextResolver implements ContextResolver {
  public constructor(
    private readonly store: ContextStore,
    private readonly sink: EventSink,
    private readonly idGenerator: IdGenerator,
    private readonly clock: Clock,
  ) {}

  public async resolve<T>(
    requester: ContextRequester,
    name: string,
    guard: ContextGuard<T>,
  ): Promise<Result<ResolvedContext<T>, ContextResolveError>> {
    let context;
    try {
      context = await this.store.getByName(name);
    } catch {
      await this.emitError(requester, name, "NOT_FOUND");
      return failure<ResolvedContext<T>, ContextResolveError>(new ContextResolveErrorClass(name, "NOT_FOUND"));
    }

    if (!guard(context.payload)) {
      await this.emitError(requester, name, "INVALID_SHAPE");
      return failure<ResolvedContext<T>, ContextResolveError>(new ContextResolveErrorClass(name, "INVALID_SHAPE"));
    }

    const resolved: ResolvedContext<T> = {
      context: context.payload,
      secrets: { ...context.secrets },
    };
    return success<ResolvedContext<T>, ContextResolveError>(resolved);
  }

  private async emitError(
    requester: ContextRequester,
    name: string,
    reason: "NOT_FOUND" | "INVALID_SHAPE",
  ): Promise<void> {
    const payload: ErrorContextPayload = {
      requesterKind: requester.kind,
      requesterId: requester.id,
      contextName: name,
      reason,
    };
    const producerEventId = `error.context/${requester.kind}/${requester.id}/${name}/${reason}`;
    const event = new Event<unknown>(
      this.idGenerator.generate(),
      CONCORD_PRODUCER_ID,
      producerEventId,
      this.clock.now(),
      ERROR_CONTEXT,
      payload,
    );
    event.markMuted();
    await this.sink.emit(event);
  }
}
