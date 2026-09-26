import type { Producer } from "../src/domain/ports/in/producer";
import type { EventSink } from "../src/domain/ports/in/event-sink";
import type { Registration } from "../src/domain/ports/in/registration";
import type { Rule } from "../src/domain/ports/out/rule";
import type { Handler } from "../src/domain/ports/out/handler";
import type { IdGenerator } from "../src/domain/ports/out/id-generator";
import type { Clock } from "../src/domain/ports/out/clock";
import type { PeakSchedule } from "../src/domain/ports/out/peak-schedule";
import type { PeakHoursRepository } from "../src/domain/ports/out/peak-hours-repository";
import type { ConsumerStateRepository } from "../src/domain/ports/out/consumer-state-repository";
import type { ConsumerRegistry } from "../src/domain/ports/out/consumer-registry";
import type { RunRepository } from "../src/domain/ports/out/run-repository";
import type { RunAbortRegistry } from "../src/domain/ports/out/run-abort-registry";
import type { RunTimeoutResolver } from "../src/domain/ports/out/run-timeout-resolver";
import { DEFAULT_RUN_TIMEOUT_MS } from "../src/domain/ports/out/run-timeout-resolver";
import type { RunTimeoutClock } from "../src/domain/ports/out/run-timeout-clock";
import type { RunCompletionHook } from "../src/domain/ports/out/run-completion-hook";
import { NoOpRunCompletionHook } from "../src/domain/ports/out/run-completion-hook";
import { noopLogger } from "../src/domain/ports/out/logger";
import { noopLogContextScope } from "../src/domain/ports/out/log-context";
import type { EventLifecycleObserver } from "../src/domain/ports/out/event-lifecycle-observer";
import type { Event } from "../src/domain/entities/event";
import type { Run } from "../src/domain/entities/run";
import type { Result } from "../src/domain/result";
import { success, failure } from "../src/domain/result";
import type { EventHandlerError } from "../src/domain/exceptions/errors";
import {
  HandshakeExpiredError,
  SessionExpiredError,
  UserNotFoundError,
} from "../src/domain/exceptions/errors";
import type { Credential } from "../src/domain/entities/credential";
import type { CredentialStore } from "../src/domain/ports/out/credential-store";
import type { CredentialIssuer, IssuedCredential } from "../src/domain/ports/out/credential-issuer";
import type {
  SrpHandshake,
  SrpHandshakeBeginResult,
  SrpHandshakeCompleteResult,
  SrpFakeBeginResult,
} from "../src/domain/ports/out/srp-handshake";
import type { HandshakeStore, StoredHandshake } from "../src/domain/ports/out/handshake-store";
import type { SessionStore, SessionValue } from "../src/domain/ports/out/session-store";
import type { NonceCache } from "../src/domain/ports/out/nonce-cache";
import type { SignatureVerifier } from "../src/domain/ports/out/signature-verifier";
import type { PasswordSecretDeriver } from "../src/domain/ports/out/password-secret-deriver";
import { RunDispatcher } from "../src/domain/interactors/run-dispatcher";
import { InMemoryPeakHoursRepository } from "../src/infra/adapters/stores/in-memory-peak-hours-repository";
import { InMemoryConsumerStateRepository } from "../src/infra/adapters/stores/in-memory-consumer-state-repository";
import { InMemoryConsumerRegistry } from "../src/infra/adapters/registry/in-memory-consumer-registry";
import { InMemoryRunAbortRegistry } from "../src/infra/adapters/registry/in-memory-run-abort-registry";
import { InMemoryRunTimeoutClock } from "../src/infra/adapters/registry/in-memory-run-timeout-clock";
import { NoOpEventLifecycleObserver } from "../src/infra/adapters/api/no-op-event-lifecycle-observer";

export class SequentialIdGenerator implements IdGenerator {
  private counter = 0;

  public generate(): string {
    this.counter += 1;
    return `id-${this.counter}`;
  }
}

export class FixedClock implements Clock {
  public constructor(private readonly when: Date) {}

  public now(): Date {
    return this.when;
  }
}

export class FakeProducer implements Producer {
  public constructor(
    public readonly producerId: string,
    private readonly events: Event<unknown>[],
  ) {}

  public register(registration: Registration): void {
    registration.addProducer(this);
  }

  public async start(sink: EventSink): Promise<void> {
    for (const event of this.events) {
      await sink.emit(event);
    }
  }

  public async stop(): Promise<void> {}
}

export class TypeRule implements Rule<unknown> {
  public constructor(private readonly type: string) {}

  public decide(event: Event<unknown>): boolean {
    return event.type === this.type;
  }
}

export class RecordingHandler implements Handler<unknown> {
  public readonly calls: Run<unknown>[] = [];
  public readonly signals: AbortSignal[] = [];
  private abortWaiters: Array<() => void> = [];

  public constructor(private readonly outcome: Result<void, EventHandlerError>) {}

  public async handle(run: Run<unknown>, signal: AbortSignal): Promise<Result<void, EventHandlerError>> {
    this.calls.push(run);
    this.signals.push(signal);
    signal.addEventListener("abort", () => {
      for (const waiter of this.abortWaiters) {
        waiter();
      }
      this.abortWaiters = [];
    });
    return this.outcome;
  }

  public waitForAbort(timeoutMs = 1000): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("waitForAbort timed out")), timeoutMs);
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      if (this.signals.some((signal) => signal.aborted)) {
        clearTimeout(timer);
        resolve();
        return;
      }
      this.abortWaiters.push(onAbort);
    });
  }
}

export class ThrowingHandler implements Handler<unknown> {
  public readonly calls: Run<unknown>[] = [];

  public constructor(private readonly error: unknown) {}

  public async handle(run: Run<unknown>, _signal: AbortSignal): Promise<Result<void, EventHandlerError>> {
    this.calls.push(run);
    throw this.error;
  }
}

export class HangingHandler implements Handler<unknown> {
  public readonly calls: Run<unknown>[] = [];
  public readonly signals: AbortSignal[] = [];
  public readonly observed: AbortSignal[] = [];
  private resolveHandler: ((result: Result<void, EventHandlerError>) => void) | null = null;
  private readonly promise: Promise<Result<void, EventHandlerError>>;

  public constructor(private readonly outcome: Result<void, EventHandlerError> = success(undefined)) {
    this.promise = new Promise((resolve) => {
      this.resolveHandler = resolve;
    });
  }

  public async handle(run: Run<unknown>, signal: AbortSignal): Promise<Result<void, EventHandlerError>> {
    this.calls.push(run);
    this.signals.push(signal);
    signal.addEventListener("abort", () => {
      this.observed.push(signal);
      if (this.resolveHandler !== null) {
        this.resolveHandler(this.outcome);
        this.resolveHandler = null;
      }
    });
    return this.promise;
  }
}

export function successfulOutcome(): Result<void, EventHandlerError> {
  return success(undefined);
}

export async function waitFor<T>(
  probe: () => T | undefined,
  timeoutMs = 1000,
  intervalMs = 10,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = probe();
    if (value !== undefined) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("waitFor timed out");
}

export class InMemoryCredentialStoreFake implements CredentialStore {
  public readonly saved: Credential[] = [];
  public readonly deleted: string[] = [];
  private readonly credentials: Map<string, Credential> = new Map();

  public async getByName(username: string): Promise<Credential> {
    const credential = this.credentials.get(username);
    if (credential === undefined) {
      throw new UserNotFoundError(username);
    }
    return credential;
  }

  public async exists(username: string): Promise<boolean> {
    return this.credentials.has(username);
  }

  public async save(credential: Credential): Promise<Result<void, Error>> {
    this.credentials.set(credential.username, credential);
    this.saved.push(credential);
    return success(undefined);
  }

  public async delete(username: string): Promise<Result<void, Error>> {
    this.credentials.delete(username);
    this.deleted.push(username);
    return success(undefined);
  }

  public seed(credential: Credential): void {
    this.credentials.set(credential.username, credential);
  }
}

export class FakeCredentialIssuer implements CredentialIssuer {
  public readonly generateCalls: Array<{ username: string; password: string }> = [];

  public constructor(private readonly issued: IssuedCredential) {}

  public async generate(username: string, password: string): Promise<IssuedCredential> {
    this.generateCalls.push({ username, password });
    return this.issued;
  }
}

export class FakeSrpHandshake implements SrpHandshake {
  public readonly beginCalls: Array<{ clientPublicEphemeral: string; credential: Credential }> = [];
  public readonly completeCalls: Array<{
    serverSecret: string;
    clientPublicEphemeral: string;
    credential: Credential;
    clientSessionProof: string;
  }> = [];
  public readonly fakeCalls: Array<{ username: string; clientPublicEphemeral: string }> = [];

  public constructor(
    private readonly beginResult: SrpHandshakeBeginResult,
    private readonly completeResult: SrpHandshakeCompleteResult,
    private readonly fakeResult: SrpFakeBeginResult,
    private readonly completeShouldThrow: unknown = null,
  ) {}

  public async begin(clientPublicEphemeral: string, credential: Credential): Promise<SrpHandshakeBeginResult> {
    this.beginCalls.push({ clientPublicEphemeral, credential });
    return this.beginResult;
  }

  public async complete(
    serverSecret: string,
    clientPublicEphemeral: string,
    credential: Credential,
    clientSessionProof: string,
  ): Promise<SrpHandshakeCompleteResult> {
    this.completeCalls.push({ serverSecret, clientPublicEphemeral, credential, clientSessionProof });
    if (this.completeShouldThrow !== null) {
      throw this.completeShouldThrow;
    }
    return this.completeResult;
  }

  public async beginFake(username: string, clientPublicEphemeral: string): Promise<SrpFakeBeginResult> {
    this.fakeCalls.push({ username, clientPublicEphemeral });
    return this.fakeResult;
  }
}

export class FakeHandshakeStore implements HandshakeStore {
  public readonly store: Map<string, StoredHandshake> = new Map();

  public async put(id: string, payload: StoredHandshake): Promise<void> {
    this.store.set(id, payload);
  }

  public async take(id: string): Promise<StoredHandshake> {
    const payload = this.store.get(id);
    if (payload === undefined) {
      throw new HandshakeExpiredError(id);
    }
    this.store.delete(id);
    return payload;
  }
}

export class FakeSessionStore implements SessionStore {
  public readonly sessions: Map<string, SessionValue> = new Map();
  public readonly touches: Array<{ id: string; expiresAt: Date }> = [];
  private counter = 0;

  public async create(value: SessionValue): Promise<string> {
    this.counter += 1;
    const id = `session-${this.counter}`;
    this.sessions.set(id, value);
    return id;
  }

  public async get(id: string): Promise<SessionValue> {
    const value = this.sessions.get(id);
    if (value === undefined) {
      throw new SessionExpiredError(id);
    }
    return value;
  }

  public async touch(id: string, expiresAt: Date): Promise<void> {
    this.touches.push({ id, expiresAt });
  }
}

export class FakeNonceCache implements NonceCache {
  public readonly seen: Set<string> = new Set();
  public readonly calls: Array<{ nonce: string; timestamp: number }> = [];
  private returnAlreadySeen = false;

  public willReturnAlreadySeen(): void {
    this.returnAlreadySeen = true;
  }

  public async saw(nonce: string, timestamp: number): Promise<boolean> {
    this.calls.push({ nonce, timestamp });
    if (this.seen.has(nonce)) {
      return true;
    }
    this.seen.add(nonce);
    if (this.returnAlreadySeen) {
      return true;
    }
    return false;
  }
}

export class FakeSignatureVerifier implements SignatureVerifier {
  public readonly calls: Array<{ key: string; message: string; signature: string }> = [];
  private nextResult = true;

  public willReturn(result: boolean): void {
    this.nextResult = result;
  }

  public verify(key: string, message: string, signature: string): boolean {
    this.calls.push({ key, message, signature });
    return this.nextResult;
  }
}

export class RecordingEventSink implements EventSink {
  public readonly events: Event<unknown>[] = [];

  public async emit(event: Event<unknown>): Promise<void> {
    this.events.push(event);
  }

  public async emitDetached(event: Event<unknown>): Promise<void> {
    this.events.push(event);
  }
}

export class FakePasswordSecretDeriver implements PasswordSecretDeriver {
  public readonly calls: Array<{ password: string; salt: string }> = [];

  public constructor(private readonly digest: string) {}

  public async derive(password: string, salt: string): Promise<string> {
    this.calls.push({ password, salt });
    return this.digest;
  }
}

export class FakePeakSchedule implements PeakSchedule {
  public constructor(
    private readonly peak: boolean,
    private readonly boundary: Date | null = null,
  ) {}

  public isPeakAt(peakHours: PeakHours | null): boolean {
    if (peakHours === null) {
      return false;
    }
    return this.peak;
  }

  public nextOffPeakBoundary(): Date | null {
    return this.boundary;
  }
}

export interface DispatcherDeps {
  readonly runRepository: RunRepository;
  readonly idGenerator: IdGenerator;
  readonly observer?: EventLifecycleObserver;
  readonly abortRegistry?: RunAbortRegistry;
  readonly clock: Clock;
  readonly peakHoursRepository?: PeakHoursRepository;
  readonly peakSchedule?: PeakSchedule;
  readonly consumerStateRepository?: ConsumerStateRepository;
  readonly consumerRegistry?: ConsumerRegistry;
  readonly timeoutResolver?: RunTimeoutResolver;
  readonly timeoutClock?: RunTimeoutClock;
  readonly completionHook?: RunCompletionHook;
  readonly inputTimeoutMs?: number;
}

export function buildDispatcher(deps: DispatcherDeps): RunDispatcher {
  return new RunDispatcher(
    deps.runRepository,
    deps.idGenerator,
    deps.observer ?? new NoOpEventLifecycleObserver(),
    deps.abortRegistry ?? new InMemoryRunAbortRegistry(),
    deps.clock,
    deps.peakHoursRepository ?? new InMemoryPeakHoursRepository(),
    deps.peakSchedule ?? new FakePeakSchedule(false),
    deps.consumerStateRepository ?? new InMemoryConsumerStateRepository(),
    deps.consumerRegistry ?? new InMemoryConsumerRegistry(),
    deps.timeoutResolver ?? new FixedRunTimeoutResolver(DEFAULT_RUN_TIMEOUT_MS),
    deps.timeoutClock ?? new InMemoryRunTimeoutClock(),
    noopLogger,
    noopLogContextScope,
    deps.completionHook ?? new NoOpRunCompletionHook(),
    deps.inputTimeoutMs,
  );
}

export class FixedRunTimeoutResolver implements RunTimeoutResolver {
  public constructor(private readonly timeoutMs: number) {}

  public async resolve(_consumerId: string): Promise<number> {
    return this.timeoutMs;
  }
}

export { failure };
