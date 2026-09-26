import type { RepoRef } from "../../producers/github/github-client";
import type {
  PrEventPayload,
  PrMissingPayload,
  RepoRefDto,
} from "../../producers/github/pull-request";
import { PR_MISSING } from "../../producers/github/pull-request";
import type { InlineProducer } from "../../producers/inline/inline-producer";

import type { AgentTaskRunner } from "./agent-task-runner";
import { prMissingEventId } from "./pr-missing-event-id";

export interface PrCodeProducingRequest {
  readonly consumerId: string;
  readonly runId: string;
  readonly payload: PrEventPayload;
  readonly prompt: string;
  readonly source: string;
  // Optional structured-output schema for the agent session (see
  // AgentTaskRunner.CodeProducingRequest.schema). When set and the agent's
  // verdict reports a design escalation, the no-commit guard is skipped: the
  // agent deliberately stopped to ask a human instead of finishing, which is
  // not the silent no-op stall the guard exists to catch.
  readonly schema?: object;
}

export type PrCodeProducingOutcome =
  | { readonly ok: true; readonly emitted: boolean; readonly output: unknown; readonly worktreePath: string }
  | { readonly ok: false; readonly reason: "repo-not-found" | "no-commit" };

export async function runPrCodeProducing(
  taskRunner: AgentTaskRunner,
  producer: InlineProducer,
  request: PrCodeProducingRequest,
  signal?: AbortSignal,
): Promise<PrCodeProducingOutcome> {
  const payload = request.payload;
  const ref: RepoRef = { owner: payload.repo.owner, repo: payload.repo.repo };
  const result = await taskRunner.runCodeProducingTask(
    {
      consumerId: request.consumerId,
      runId: request.runId,
      repo: ref,
      branch: { kind: "existing", branch: payload.headRef },
      prompt: request.prompt,
      source: request.source,
      schema: request.schema,
    },
    signal,
  );
  if (!result.ok) {
    return { ok: false, reason: result.reason };
  }
  if (isEscalatedVerdict(request.schema !== undefined ? result.output : null)) {
    return { ok: true, emitted: false, output: result.output, worktreePath: result.worktreePath };
  }
  // Consumers that operate on a branch whose PR already exists find the PR
  // after the agent runs does NOT prove the agent did any work. The durable
  // signal that the rework landed is a new head commit: the producer emits the
  // next pr.tests_succeeded only when the head SHA advances. When the agent
  // edits files but never commits/pushes (observed in production: the agent
  // verified its changes and ended the turn without running git), the branch
  // head is unchanged and the verify/rework loop would silently terminate with
  // the PR left open. Detect that here and surface it as a failure instead of
  // letting the run report a no-op success.
  if (result.prExists) {
    if (result.headSha === payload.headSha) {
      return { ok: false, reason: "no-commit" };
    }
    return { ok: true, emitted: false, output: result.output, worktreePath: result.worktreePath };
  }
  const repo: RepoRefDto = payload.repo;
  const missingPayload: PrMissingPayload = {
    repo,
    branch: result.branch,
    worktreePath: result.worktreePath,
    source: request.source,
  };
  // The worktree's path rides the event payload; the publishing run (a separate consumer)
  // needs it and removes it after publishing. Mark it handed off BEFORE the
  // emit so this run's own completion cleanup cannot tear it down in between.
  taskRunner.handoffWorktree(result.worktreePath);
  await producer.emit(prMissingEventId(repo, result.branch), PR_MISSING, missingPayload);
  return { ok: true, emitted: true, output: result.output, worktreePath: result.worktreePath };
}

// Detects a design-escalation verdict shape on a structured
// output. Kept structural (not importing the schema module) so the shared
// helper stays dependency-free; the handler re-validates with the full guard.
function isEscalatedVerdict(output: unknown): boolean {
  if (typeof output !== "object" || output === null) {
    return false;
  }
  return (output as { escalated?: unknown }).escalated === true;
}
