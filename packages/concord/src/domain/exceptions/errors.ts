import type { RunState } from "../entities/run";

export class ConcordError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = new.target.name;
    if (Object.setPrototypeOf !== undefined) {
      Object.setPrototypeOf(this, new.target.prototype);
    }
  }
}

export class IllegalRunTransitionError extends ConcordError {
  public constructor(
    public readonly from: RunState,
    public readonly to: RunState,
  ) {
    super(`Illegal run transition: ${from} -> ${to}`);
  }
}

export class RunNotFoundError extends ConcordError {
  public constructor(public readonly runId: string) {
    super(`Run not found: ${runId}`);
  }
}

export class RunNotAbortableError extends ConcordError {
  public constructor(
    public readonly runId: string,
    public readonly state: RunState,
  ) {
    super(`Run cannot be aborted: ${runId} (state=${state})`);
  }
}

export class RunNotRestartableError extends ConcordError {
  public constructor(
    public readonly runId: string,
    public readonly state: RunState,
  ) {
    super(`Run cannot be restarted: ${runId} (state=${state})`);
  }
}

export class EventNotFoundError extends ConcordError {
  public constructor(public readonly eventId: string) {
    super(`Event not found: ${eventId}`);
  }
}

export class EventNotReplayableError extends ConcordError {
  public constructor(public readonly eventId: string) {
    super(`Event cannot be replayed: ${eventId}`);
  }
}

export class ProducerNotFoundError extends ConcordError {
  public constructor(public readonly producerId: string) {
    super(`Producer not found: ${producerId}`);
  }
}

export class ProducerNotDisableableError extends ConcordError {
  public constructor(public readonly producerId: string) {
    super(`Producer cannot be disabled: ${producerId}`);
  }
}

export class ConsumerNotFoundError extends ConcordError {
  public constructor(public readonly consumerId: string) {
    super(`Consumer not found: ${consumerId}`);
  }
}

export class ConsumerDisabledError extends ConcordError {
  public constructor(public readonly consumerId: string) {
    super(`Consumer is disabled: ${consumerId}`);
  }
}

export class PersistenceError extends ConcordError {
  public constructor(public readonly cause: unknown) {
    super(
      `Persistence error: ${PersistenceError.describe(cause)}`,
    );
  }

  private static describe(cause: unknown): string {
    if (cause instanceof Error) {
      return cause.message;
    }
    return String(cause);
  }
}

export class EventHandlerError extends ConcordError {
  public constructor(message: string) {
    super(message);
  }
}

/**
 * Signals that a run no longer needs to do its work because the world moved on
 * while it was waiting (typically parked in WAIT_FOR_OFFPEAK). Examples: the PR
 * was merged/closed and its branch deleted before its consumer started, or a newer
 * run superseded an older one for the same subject. The
 * RunDispatcher recognises this sentinel and transitions the run to the
 * SUPERSEDED terminal state instead of FAILED, so the run is surfaced as
 * intentionally skipped rather than as a failure.
 */
export class RunSupersededError extends EventHandlerError {
  public constructor(public readonly reason: string) {
    super(reason);
  }
}

export class UnexpectedHandlerError extends EventHandlerError {
  public constructor(public readonly cause: unknown) {
    super(`Unexpected error thrown by handler: ${UnexpectedHandlerError.describe(cause)}`);
  }

  private static describe(cause: unknown): string {
    if (cause instanceof Error) {
      return cause.message;
    }
    return String(cause);
  }
}

export class UnexpectedStateError extends ConcordError {
  public constructor(message: string) {
    super(message);
  }
}

/** The directory an agent server was about to be spawned into disappeared
 * between worktree acquisition and spawn — in production, a worktree
 * reclaimed by run-completion cleanup that raced the next run in the same
 * event chain (concord#24). Kept as a distinct error so the failure names
 * the actual problem instead of surfacing as three bare spawn-ENOENT health
 * loop attempts. */
export class WorktreeVanishedError extends UnexpectedStateError {
  public constructor(worktreePath: string) {
    super(
      `worktree directory vanished before its agent server could spawn: ${worktreePath} no longer exists ` +
        `(likely reclaimed by cleanup while a run was still using it — see concord#24)`,
    );
    this.name = "WorktreeVanishedError";
  }
}

export class ContextNotFoundError extends ConcordError {
  public constructor(public readonly name: string) {
    super(`Context not found: ${name}`);
  }
}

export class ContextAlreadyExistsError extends ConcordError {
  public constructor(public readonly name: string) {
    super(`Context already exists: ${name}`);
  }
}

export type ContextResolveReason = "NOT_FOUND" | "INVALID_SHAPE";

export class ContextResolveError extends ConcordError {
  public constructor(
    public readonly name: string,
    public readonly reason: ContextResolveReason,
  ) {
    super(`Context resolution failed: ${name} (${reason})`);
  }
}

export class UserNotFoundError extends ConcordError {
  public constructor(public readonly username: string) {
    super(`User not found: ${username}`);
  }
}

export class UserAlreadyExistsError extends ConcordError {
  public constructor(public readonly username: string) {
    super(`User already exists: ${username}`);
  }
}

export class AuthenticationError extends ConcordError {
  public constructor(message: string) {
    super(message);
  }
}

export class InvalidProofError extends AuthenticationError {
  public constructor() {
    super("Invalid SRP proof");
  }
}

export class HandshakeExpiredError extends AuthenticationError {
  public constructor(public readonly handshakeId: string) {
    super(`Handshake expired or unknown: ${handshakeId}`);
  }
}

export class SessionExpiredError extends AuthenticationError {
  public constructor(public readonly sessionId: string) {
    super(`Session expired or unknown: ${sessionId}`);
  }
}

export class StaleRequestError extends AuthenticationError {
  public constructor() {
    super("Request timestamp is outside the freshness window");
  }
}

export class ReplayDetectedError extends AuthenticationError {
  public constructor(public readonly nonce: string) {
    super(`Replay detected for nonce: ${nonce}`);
  }
}

export class InvalidSignatureError extends AuthenticationError {
  public constructor() {
    super("Invalid request signature");
  }
}

export type InvalidPeakHoursField = "start" | "end" | "timezone";

export class InvalidPeakHoursError extends ConcordError {
  public constructor(
    public readonly field: InvalidPeakHoursField,
    message: string,
  ) {
    super(message);
  }
}

export class InvalidConsumerConfigError extends ConcordError {
  public constructor(message: string) {
    super(message);
  }
}

export class MissingGitWorkingTreeError extends ConcordError {
  public constructor(
    public readonly repoName: string,
    public readonly expectedPath: string,
  ) {
    super(
      `Primary git working tree for repo "${repoName}" does not exist at "${expectedPath}". ` +
        `Clone the repository there (e.g. \`git clone <url> ${expectedPath}\`) or update the github-repos context to point at the right path.`,
    );
  }
}

export class FormNotFoundError extends ConcordError {
  public constructor(public readonly formId: string) {
    super(`Form not found: ${formId}`);
  }
}

export class FormAlreadyAnsweredError extends ConcordError {
  public constructor(public readonly formId: string) {
    super(`Form already answered: ${formId}`);
  }
}

export class RunNotPendingInputError extends ConcordError {
  public constructor(public readonly runId: string) {
    super(`Run is not pending input: ${runId}`);
  }
}

export class InvalidFormAnswersError extends ConcordError {
  public constructor(message: string) {
    super(message);
  }
}

export class InputRoundsExceededError extends ConcordError {
  public constructor(
    public readonly runId: string,
    public readonly maxRounds: number,
  ) {
    super(`Input rounds limit reached for run ${runId} (max ${maxRounds})`);
  }
}

export class EventTemplateNotFoundError extends ConcordError {
  public constructor(public readonly templateId: string) {
    super(`Event template not found: ${templateId}`);
  }
}

export class InvalidEventTemplateAnswersError extends ConcordError {
  public constructor(message: string) {
    super(message);
  }
}
