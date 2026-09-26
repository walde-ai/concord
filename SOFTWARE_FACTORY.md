# Building a software factory with Concord

This guide shows how to turn any codebase into a software factory: every
change on a pull request becomes an event, an agent verifies it against your
integration tests, another agent fixes whatever is broken, and the loop runs
until the change is green and safe to merge. Feature work enters the same
loop through specs: an agent scopes a request into a written spec, another
agent implements it, and the resulting pull request goes through the same
verification. Humans intervene where you decide they should, and nowhere
else.

Every mechanism described here is part of the public `@walde.ai/concord`
package. The concrete factory this design comes from runs a handful of
private repositories; the consumers it uses are deliberately not shipped,
because a factory encodes your review policy. You will write four small
consumers (verify, rework, merge, and optionally publish) plus two for the
spec flow, and wire them in a composition. Each consumer is 50 to 150 lines
of TypeScript.

## The loop

```
                     +-----------------------+
                     |  GitHub PR producer   |
                     |  (polls open PRs)     |
                     +-----------+-----------+
             pr.opened, pr.tests_failed, pr.tests_succeeded,
             pr.merge_conflicts, pr.missing
                                 |
                                 v
        +------------------------+------------------------+
        |              verify consumer (agent)            |
        |  checks out the PR, runs integration tests,     |
        |  returns a structured verdict                   |
        +------------------------+------------------------+
              verdict ok                verdict not ok
                 |                            |
   pr.validation_succeeded      pr.validation_failed
                 |                            |
                 v                            v
        +---------------+        +--------------------------+
        | merge consumer|        | rework consumer (agent)  |
        | squash-merges |        | fixes the branch, pushes |
        +---------------+        +--------------------------+
                                          |
                              push restarts CI checks
                                          |
                              pr.tests_succeeded again
                                          |
                                  verify runs again
```

The loop closes through GitHub itself: when the rework agent pushes commits
to the pull request branch, GitHub re-runs the checks, the producer sees the
new check state, and the verify consumer runs again on the updated branch.
Nothing in the engine knows about the iteration count; the pull request
simply cycles until verification passes or a human intervenes.

## Prerequisites

You need Node.js 20 or newer, git, and the `gh` CLI logged in (`gh auth
login`); the GitHub PR producer takes its token from `gh` unless you configure
per-consumer tokens later. You also need [opencode](https://opencode.ai)
installed and configured with at least one model provider. Concord runs its
agents through opencode, so any provider opencode supports works: Claude
models from Anthropic, GPT models from OpenAI, Gemini models from Google,
Qwen, Grok, DeepSeek, or local models through Ollama. Finally you need the
repository (or repositories) the factory will operate on, cloned locally on
the same machine.

## Step 1: Run the engine

Install and start the server, create the first user, and register the
repository the factory will watch:

```bash
npm install @walde.ai/concord
export CONCORD_DATABASE_PATH=/var/lib/concord/concord.db
export CONCORD_API_PORT=5985

npx concord-server &          # SQLite + HTTP/WS API + dashboard

npx concord user create --name admin --password "<ADMIN_PWD>"

npx concord context upsert --local=true \
  --name github-repos \
  --content '{"repos":[
    {"name":"app","url":"https://github.com/your-org/app","local":"/srv/app"}
  ]}'
```

The `local` path matters: agent runs create git worktrees under that clone
instead of fetching from GitHub, which keeps runs fast and offline-capable.
The `github-repos` context is what the producer and the agent runner read;
add one entry per repository. See `QUICKSTART.md` for the full context
schema.

## Step 2: Pick models and agents

Every agent consumer reads its model and agent profile from persisted
consumer configuration, using the shared schema with keys `modelId`,
`agentName`, `maxInputRounds`, and `runTimeoutMs`. The same consumer can run
different models per deployment without code changes:

```bash
npx concord consumer-config set --id pr-verify \
  --values '{"modelId":"anthropic/claude-sonnet-4.5","agentName":"verify","runTimeoutMs":1800000}'
npx concord consumer-config set --id pr-rework \
  --values '{"modelId":"anthropic/claude-sonnet-4.5","agentName":"rework","runTimeoutMs":3600000}'
```

`agentName` selects an opencode agent profile (defined in your repository's
`AGENTS.md` or the opencode configuration). Use profiles to give each
consumer its own system prompt and tool restrictions: the verify agent does
not need to push, the rework agent does. `maxInputRounds` caps how many
times an agent may stop and ask a human for input before its run fails; set
it to 0 for consumers that must run unattended.

## Step 3: Know the event vocabulary

The GitHub PR producer emits one event per observed state change, after
deduplication through its persistent lifecycle store. Your consumers emit
the validation events themselves. The full vocabulary:

| Event | Emitted by | Meaning |
| --- | --- | --- |
| `pr.opened` | producer | A pull request appeared in a watched repo. |
| `pr.tests_failed` | producer | The PR's latest head has failing check runs. |
| `pr.tests_succeeded` | producer | The PR's latest head has passing check runs. |
| `pr.merge_conflicts` | producer | The PR became unmergeable (conflicts with the base branch). |
| `pr.missing` | producer | A known fix branch exists but its PR is gone (closed or merged elsewhere). |
| `pr.merged` | producer | The PR was merged. |
| `pr.validation_succeeded` | your verify consumer | An agent reviewed the change and approved it. |
| `pr.validation_failed` | your verify consumer | An agent reviewed the change and rejected it, with reasons. |

Every event carries the repository reference, PR number, head SHA, and
branch name in its payload (see `PrEventPayload` in the package exports),
which is all a consumer needs to act.

## Step 4: The verify consumer

The verify consumer is the factory's quality gate. It listens for
`pr.tests_succeeded` (CI already passed, so the agent reviews what CI cannot
check), runs an agent over the diff in a worktree of the PR branch, and
emits a validation event with a structured verdict. Anything the agent
throws is caught by the dispatcher and recorded as a failed run, so a
crashing model degrades to "no verdict", never to "approved".

The rule is one line:

```ts
import { PR_TESTS_SUCCEEDED, type Rule, type Event } from "@walde.ai/concord";

class VerifyRule implements Rule<unknown> {
  public decide(event: Event<unknown>): boolean {
    return event.type === PR_TESTS_SUCCEEDED;
  }
}
```

The handler runs the agent through `AgentTaskRunner.runReviewTask`, which
resolves the repo entry, checks out the PR branch into a run-scoped
worktree, and invokes the agent with a structured-output schema. The verdict
schema is where you encode what "verified" means for your codebase:

```ts
const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["approved", "rejected"] },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: { type: "string", enum: ["blocking", "note"] },
          file: { type: "string" },
          description: { type: "string" },
        },
        required: ["severity", "description"],
      },
    },
  },
  required: ["verdict", "findings"],
} as const;
```

The handler then maps the verdict to the next event through an
`InlineProducer` registered under the consumer's own producer id, so the
chain is traceable in the dashboard:

```ts
const review = await this.taskRunner.runReviewTask({
  consumerId: "pr-verify",
  runId,
  repo: payload.repo,
  branch: payload.headRef,
  prompt: buildVerifyPrompt(payload),
  schema: VERDICT_SCHEMA,
});

const verdict = review.ok ? review.output : null;
if (verdict?.verdict === "approved") {
  await this.producer.emit(`${payload.headSha}/validation_succeeded`,
    PR_VALIDATION_SUCCEEDED, { ...payload, findings: verdict.findings });
} else {
  await this.producer.emit(`${payload.headSha}/validation_failed`,
    PR_VALIDATION_FAILED, { ...payload, findings: verdict?.findings ?? [] });
}
```

Two properties are worth designing for. Give the producer event id the head
SHA (as above): replays and repeated `pr.tests_succeeded` events for the
same commit deduplicate instead of double-running the agent. And write the
prompt to instruct the agent to run the integration suite itself and treat
its exit code as ground truth, so the verdict reflects an execution and not
an impression.

Human escalation in verify is optional, not required. If you want it, the
handler calls `app.requestRunInput` with a small form (approve / reject /
comment) whenever the verdict is uncertain, and the dashboard parks the run
until a human answers. Set `maxInputRounds` to control how often this can
happen per run. Skip it entirely and the factory runs with no human in the
loop; both configurations are supported.

## Step 5: The rework consumer (the fixing loop)

The rework consumer listens for `pr.validation_failed` and produces a fix.
It runs through `AgentTaskRunner.runCodeProducingTask` with a branch
specification of kind `existing` pointed at the PR branch, so the agent
works directly on the pull request:

```ts
const result = await this.taskRunner.runCodeProducingTask({
  consumerId: "pr-rework",
  runId,
  repo: payload.repo,
  branch: { kind: "existing", branch: payload.headRef },
  prompt: buildReworkPrompt(payload, findings),
  source: "pr.validation_failed",
});
```

The task runner commits and pushes whatever the agent produced (or reports
that it produced nothing, which you should treat as a failed run). The push
makes GitHub re-run the checks on the pull request, the producer emits
`pr.tests_succeeded` for the new head, and verify runs again. That is the
whole loop: no orchestration code knows it is iterating.

The rework prompt must include the verify findings verbatim and the exact
command that runs the integration suite. Instruct the agent to reproduce the
failure first, fix it, run the suite again, and stop when the suite passes.
Forbid test edits in the prompt if the tests are the contract (see step 9),
or allow them in a separate findings channel if you want the agent to flag
broken tests rather than work around them. Runs that exceed
`runTimeoutMs` are aborted and marked `TIMED_OUT`, so a stuck agent cannot
park the chain forever.

## Step 6: The merge consumer

The merge consumer listens for `pr.validation_succeeded` and merges through
the GitHub client it resolves for its consumer id:

```ts
const { client } = await this.clientResolver.resolve("pr-merge");
await client.mergePullRequest(payload.repo, payload.number, "squash");
```

Merging is the only action this consumer takes. It performs no checks of its
own: by the time it runs, CI passed (the producer said so) and an agent
approved the change (the verify consumer said so). The producer emits
`pr.merged` when it observes the merge.

## Step 7: Optional consumers

Two more event types close gaps in practice. A `pr.missing` consumer sees a
known fix branch whose pull request disappeared (closed by hand, or superseded);
the useful reaction is to open a fresh pull request for the branch so the
work re-enters the loop. A `pr.merge_conflicts` consumer runs a rebase agent
over the conflicted branch using the same `runCodeProducingTask` call as
rework. Both follow the pattern of steps 4 and 5, so they are not spelled
out here.

## Step 8: The spec flow

The loop above guards existing branches. The spec flow manufactures new
ones, and it needs two consumers and two event templates.

A human starts it from the dashboard's "add event" panel using a
`spec-request` template you register: a select of the watched repos plus a
description field. The template emits a `spec.request` event. The scope
consumer picks it up, runs an agent that reads the codebase (through a
worktree, like every other agent run), optionally asks the human clarifying
questions with `requestRunInput`, and posts the result as a spec issue on
GitHub with a stable label (for example `spec`). It emits a `spec.created`
event whose payload carries the issue URL.

The second template, `spec-implement-request`, lists the open spec issues
(the template resolves its options field by querying the GitHub client for
issues with that label, so the picker stays current). A human picks one and
the template emits `spec.implement_request`. The implement consumer runs
`runCodeProducingTask` with a branch specification of kind `new` (a named
branch off the default branch), with a prompt that points at the spec issue
and demands the integration suite pass before the run finishes. It pushes
the branch and opens the pull request, and from that moment the PR loop of
steps 4 through 6 takes over: the producer emits `pr.opened` and
`pr.tests_*` like it would for any human-authored branch.

The templates are plain `EventTemplate` implementations; the package ships
`RawJsonEventTemplate` as a generic example and `EventTemplateRegistrable`
to register your own through the app's registration surface.

## Step 9: Make the integration tests the contract

The factory is exactly as trustworthy as the test suite the agents execute.
Four properties make a suite usable as the contract. It must run with one
command from the repository root (the prompts hardcode that command), exit
non-zero on any failure, need no network credentials or external services
started by hand, and finish in minutes so the loop can iterate. Flaky tests
are worse than missing tests here, because the loop will fix around them or
escalate forever.

Decide the test-editing policy in writing and encode it in both prompts. The
conservative policy, and the one this factory design assumes, is that verify
and rework never modify test files; a failing test means the code under test
is wrong or the test itself is wrong, and the agent reports which. Whatever
you choose, choose it once and state it in every prompt, or the two agents
will fight each other through the loop.

## Step 10: Wire it as a composition

Everything above assembles in one file: a composition that registers the
GitHub producer and the consumers, plus a `startServer` call. This is the
complete shape of a factory process:

```ts
import {
  startServer, GhCliCredentialsProvider, GithubPrProducerFactory,
  ConsumerGitHubClientResolver, OctokitGitHubClientFactory,
  OctokitGitHubClient, OpencodeSdkRunner, GitWorktreeManager,
  RealRunMcpBackendFactory, InMemoryConsumerConfigRepository,
  type Composition,
} from "@walde.ai/concord";

class FactoryComposition implements Composition {
  public configure() {
    return {};                       // run-completion hooks go here if you add them
  }

  public async register(app) {
    const producer = await new GithubPrProducerFactory(
      new GhCliCredentialsProvider(), app.logger, app.pullRequestLifecycleStore,
    ).create();
    app.register(producer);

    const defaultClient = new OctokitGitHubClient((await new GhCliCredentialsProvider().load()).token);
    const clientResolver = new ConsumerGitHubClientResolver(
      app.consumerSecretResolver, new OctokitGitHubClientFactory(), defaultClient,
    );
    const taskRunnerDeps = {
      runner: new OpencodeSdkRunner(undefined, undefined, undefined,
        { requestRunInput: app.requestRunInput, recordRunUpdate: app.recordRunUpdate,
          mcpBackendFactory: new RealRunMcpBackendFactory() }, app.logger, app.runActivityEmitter),
      worktrees: new GitWorktreeManager(),
      config: app.consumerConfigResolver,
    };

    app.register(new VerifyConsumer(clientResolver, taskRunnerDeps, app.logger, app.worktreeLeases));
    app.register(new ReworkConsumer(clientResolver, taskRunnerDeps, app.logger, app.worktreeLeases));
    app.register(new MergeConsumer(clientResolver, app.logger));
    app.register(new ScopeConsumer(clientResolver, taskRunnerDeps, app.logger));
    app.register(new ImplementConsumer(clientResolver, taskRunnerDeps, app.logger, app.worktreeLeases));
  }
}

await startServer(
  { host: "127.0.0.1", port: 5985, databasePath: "/var/lib/concord/concord.db" },
  new FactoryComposition(),
  { installSignalHandlers: true },
);
```

The per-consumer GitHub token secret (`githubToken`) is optional: when it is
absent, `ConsumerGitHubClientResolver` falls back to the `gh` CLI
credentials, which is the simplest way to start. When one consumer must act
as a bot identity with its own token, set it with `concord consumer-secret
set --id pr-merge --secrets '{"githubToken":"..."}'`.

If a failed run should never go unnoticed, contribute a run-completion hook
from `configure()`: it receives every terminal run with its consumer id and
failure detail, and can post the failure where your team already looks (the
pull request itself, or a chat). The engine contributes the worktree
reclamation hook the same way, which is why agents do not leak worktrees
even when they crash.

## Step 11: Operate it

The factory runs unattended, and every lever is a CLI call. Pause the whole
dispatcher for a maintenance window with `concord pause set --paused true`;
events keep accumulating and dispatch when you clear it. Disable one
consumer (`concord consumer disable --id pr-merge`) to stop auto-merging
while leaving verification running. Defer heavy consumers outside business
hours with `concord consumer-off-peak set --id pr-rework --value true` after
setting a peak window. Read what happened with `concord logs query
--consumer-id pr-verify --limit 50`, and re-run any event by hand with the
dashboard's replay action after a consumer change, to confirm the new
behavior against an old payload before trusting it live.
