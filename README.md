<p align="center">
  <img src="packages/ui/public/concord.png" width="128" alt="Concord logo" />
</p>

# Concord

Concord builds **software factories**: every change on a pull request becomes
an event, AI agents verify it against your integration tests, fix whatever
fails, and loop until the change is safe to merge. Feature work enters the
same loop as specs, scoped and implemented by agents. See
[`SOFTWARE_FACTORY.md`](./SOFTWARE_FACTORY.md) for the step-by-step guide to
building one on any codebase.

Because Concord drives its agents through
[opencode](https://opencode.ai), any coding agent works: Claude (Anthropic),
GPT (OpenAI), Gemini (Google), Qwen, Grok, DeepSeek, or local models via
Ollama. You configure the model per consumer, in persisted configuration,
without touching code.

> **Operating Concord?** Read [`QUICKSTART.md`](./QUICKSTART.md) — it is the
> step-by-step guide for building the project, bootstrapping the first user,
> configuring peak hours / pause / per-consumer enable bits, and driving every
> administrative task from the `concord` CLI. **Building a factory on top of
> it?** Read [`SOFTWARE_FACTORY.md`](./SOFTWARE_FACTORY.md) — it covers the
> PR verification loop, the fix loop, the spec flow, and the integration-test
> contract that makes the loop trustworthy. This README focuses on the
> library's architecture and API.

Concord is an event-driven engine for orchestrating AI and deterministic
workflows — the machinery underneath.

A **producer** produces an **event**. The event is signalled to every registered
**consumer**. Each consumer owns a **rule** that decides whether it wants to
handle the event; when it does, the consumer starts a **run** — the unit of
execution that carries the event through to completion. Runs are persisted,
observable through an HTTP/WebSocket API and a bundled dashboard, and can be
replayed, aborted, restarted, parked for off-peak execution, or paused
globally.

Everything ships as one package, `@walde.ai/concord`, with two binaries:

- `concord-server` — a complete generic installation out of the box: SQLite
  persistence, HTTP/WS API, the raw-json event template, and the prebuilt
  dashboard.
- `concord` — the admin CLI.

A deployment customizes the engine through a **composition**: a small object
that contributes run-completion hooks and registers its own producers,
consumers, event templates and widgets on top of the generic app.

## Install

```bash
npm install @walde.ai/concord
```

Or work from this repository:

```bash
npm install            # from the repo root, installs all workspaces
npm run build          # ui first, then the engine (embeds the UI bundle)
npm test
```

## Quick start

### Run the server

```bash
npx concord-server     # binds 127.0.0.1:3000, SQLite at .concord/concord.db,
                       # serves the bundled dashboard
CONCORD_API_PORT=5985 CONCORD_DATABASE_PATH=/var/lib/concord/concord.db npx concord-server
```

### Embed and customize

Create an `App` with `MakeApp()`, register the producers and consumers you
want via `app.register()`, and `start` it. A `Registrable` can register one
or more producers, consumers, or event templates.

```ts
import {
  MakeApp,
  WebSocketProducer,
  StdioConsumer,
} from "@walde.ai/concord";

const app = MakeApp();

// A WebSocket producer: inbound JSON is emitted as `rawjson` events.
app.register(new WebSocketProducer("127.0.0.1", 8080, "ws-1"));

// The stdio consumer: prints every handled event as one JSON line.
app.register(new StdioConsumer("stdio-1"));

await app.start();
```

For a production process, use `startServer` with an optional composition —
it builds the app, applies the composition's contributions and
registrations, starts everything, installs SIGTERM/SIGINT graceful shutdown,
and serves the bundled UI:

```ts
import { startServer, type Composition } from "@walde.ai/concord";

const composition: Composition = {
  configure: () => ({ runCompletionHooks: [myHook] }),
  register: async (app) => {
    app.register(new MyProducer());
    app.register(new MyConsumer());
  },
};

const handle = await startServer(
  { host: "127.0.0.1", port: 5985, databasePath: "/var/lib/concord/concord.db" },
  composition,
  { installSignalHandlers: true },
);
```

## Core concepts

- `Event<T>` — an immutable record of something that happened (`id`,
  `producerId`, `datetime`, `type`, `payload`).
- `Producer` — pushes events into the app through the `EventSink` it receives at
  `start` time. Every `Producer` is also a `Registrable`.
- `Registrable` — anything that can be passed to `app.register()`. It receives a
  `Registration` context and adds its producers and/or consumers to it.
- `Consumer<T>` — a value object bundling a `consumerId`, a `Rule<T>`, and a
  `Handler<T>`.
- `Rule<T>.decide(event)` — returns `true` if the consumer wants the event.
- `Handler<T>.handle(run)` — does the work and reports its outcome via a
  `Result<void, EventHandlerError>`. It reads the run but **never mutates** the
  run's state; the dispatcher owns all state transitions.
- `Run<T>` — the unit of execution for one consumer handling one event. Every
  transition is persisted to the `RunRepository` (SQLite by default,
  in-memory for tests and embeddings).
- `Context` — a named JSON blob plus secrets that producers and consumers
  resolve at runtime (e.g. which repositories to watch).
- `EventTemplate` — a form-driven way for humans to emit well-formed events
  from the dashboard or CLI.
- `Widget` — a server-rendered dashboard panel. Widgets emit declarative
  payloads (today: the `status-panel` kind) that the generic UI knows how to
  draw, so deployments add dashboards without shipping UI code.

When an event is emitted, it is stored, then dispatched **concurrently and
independently** to every consumer whose rule matches. Each match drives its own
run through the state machine, persisting every transition. A failure or throw
in one handler never prevents the others from running, and `emit` returns only
after every matching run has reached a terminal state. Events emitted from
inside a run can dispatch **detached** downstream runs so long chains never
block their emitter.

## Writing your own consumer

Implement `Rule` and `Handler`, bundle them into a `Consumer`, and wrap it with
`ConsumerRegistrable` so it can be passed to `app.register()`. Heterogeneous
payloads are erased to `unknown` at the dispatch boundary, while your own code
keeps full generics.

```ts
import {
  MakeApp,
  Consumer,
  ConsumerRegistrable,
  Event,
  type Rule,
  type Handler,
  success,
  type Result,
  type EventHandlerError,
} from "@walde.ai/concord";

class GreetRule implements Rule<string> {
  public decide(event: Event<string>): boolean {
    return event.type === "greet";
  }
}

class GreetHandler implements Handler<string> {
  public async handle(): Promise<Result<void, EventHandlerError>> {
    // ...do the work, report success/failure via Result
    return success(undefined);
  }
}

const app = MakeApp();
app.register(
  new ConsumerRegistrable(new Consumer("greeter", new GreetRule(), new GreetHandler())),
);
```

A `Handler` reports failure by returning `failure(new EventHandlerError("..."))`.
Anything a handler **throws** is caught by the dispatcher, wrapped in an
`UnexpectedHandlerError`, and treated as a failed run.

For agent workloads, `AgentTaskRunner` builds on the same contract: it checks
out a git worktree for the run, drives an [opencode](https://opencode.ai)
agent in it (with run-scoped ask-a-question and post-update MCP tools),
applies the produced commits, and reports structured verdicts. The generic
agent configuration schema (`modelId`, `agentName`, `runTimeoutMs`) is
resolved per consumer id from persisted consumer configuration.

## Writing your own producer

Implement `Producer` (which extends `Registrable`). You receive a `Registration`
in `register()` — call `registration.addProducer(this)` to add yourself, and
optionally grab shared infrastructure (`idGenerator`, `clock`, `contexts`) from
it. You are handed the `EventSink` in `start`; emit `Event`s through it.

```ts
import {
  MakeApp,
  Event,
  type Producer,
  type Registration,
  type EventSink,
  type IdGenerator,
  type Clock,
} from "@walde.ai/concord";

class TimerProducer implements Producer {
  public readonly producerId = "timer";
  private idGenerator!: IdGenerator;
  private clock!: Clock;

  public register(registration: Registration): void {
    this.idGenerator = registration.idGenerator;
    this.clock = registration.clock;
    registration.addProducer(this);
  }

  public async start(sink: EventSink): Promise<void> {
    const event = new Event<unknown>(
      this.idGenerator.generate(), "timer", this.clock.now(), "tick", { at: Date.now() },
    );
    await sink.emit(event);
  }
  public async stop(): Promise<void> {}
}

const app = MakeApp();
app.register(new TimerProducer());
await app.start();
```

## Writing your own Registrable

A `Registrable` can register multiple producers, multiple consumers, or both.
Implement `Registrable` directly when you want to bundle related components:

```ts
import {
  MakeApp,
  type Registrable,
  type Registration,
} from "@walde.ai/concord";

class MyPipeline implements Registrable {
  public register(registration: Registration): void {
    registration.addProducer(new WebSocketProducer("0.0.0.0", 8080, "ws"));
    registration.addConsumer(new Consumer<unknown>("log", new StdioRule(), new StdioHandler()));
  }
}

const app = MakeApp();
app.register(new MyPipeline());
```

## Bundled adapters

| Adapter | Role | Notes |
| --- | --- | --- |
| `WebSocketProducer` | Producer | A WebSocket **server**. Inbound JSON is emitted as `rawjson` events; unparseable messages are logged and dropped. |
| `InlineProducer` | Producer | Emits events programmatically from inside handlers; used by run-input and by consumers that emit follow-up events. |
| `GithubPrProducer` (+ factory) | Producer | Polls the open pull requests of the repos listed in the `github-repos` context and emits the `PR_*` event family (opened, merge conflicts, tests failed/succeeded, validation failed/succeeded, merged, missing). Ships with an Octokit client, `gh`-CLI credentials provider, a persistent PR lifecycle store (SQLite or in-memory), and check-run/check-suite/issue models. |
| `StdioConsumer` | Consumer | Prints every handled event as one JSON line to stdout. |
| `TelegramNotifierConsumer` | Consumer | Posts run notifications to a Telegram bot; configured per deployment through consumer configuration and secrets. |
| `AgentTaskRunner` | Agent machinery | Runs an opencode agent in a per-run git worktree: branch handling, structured verdict prompts, run input forms, activity streaming. Built on `GitWorktreeManager`, `WorktreeLeaseRegistry`, `OpencodeSdkRunner`, and the run-input/run-update MCP servers. |
| `WorktreeGarbageCollector` | Git machinery | Startup pass that reclaims worktrees orphaned by crashes or restarts. |
| `SqlitePersistenceFactory` | Stores | SQLite implementations of every persistence port: events, runs, run updates, contexts, credentials, sessions, consumer config/state, producer state, peak hours, pause state, logs, PR lifecycle. In-memory implementations exist for every port for tests and embeddings. |
| `HttpApiServer` + `StreamBroadcaster` | API | Signed-request HTTP API and WebSocket activity stream; serves the bundled dashboard. SRP-based login, per-user credentials. |
| `RawJsonEventTemplate` | Event template | The generic template behind the dashboard's "add event" panel. |
| Widget framework | Widgets | Registry plus the declarative `status-panel` payload kind; the UI renders registered widgets from server payloads. |
| `startServer`, `concord-server`, `concord` | Server & CLI | The server bootstrap with the composition contract, and the admin CLI (handler table extensible with extra noun/verb handlers). |
| `InMemory*Registry`, `UuidIdGenerator`, `SystemClock`, `StructuredLogger` | System | Registries and system ports used by the dispatcher, API and producers. |

## Customising the composition

`MakeApp()` accepts an optional `AppConfig` so tests and advanced users can
substitute any adapter (e.g. inject a deterministic `IdGenerator` and `Clock`),
choose SQLite by `databasePath`, and contribute `runCompletionHooks`:

```ts
import { MakeApp, InMemoryRunRepository, ... } from "@walde.ai/concord";

const runRepository = new InMemoryRunRepository();
const app = MakeApp({
  runRepository,
  idGenerator: myIdGenerator,
  clock: myClock,
});

// runs are persisted on every transition; read them back to inspect outcomes:
// const run = await runRepository.getById(id); // run.state === "SUCCEEDED"
```

## Architecture

The package follows clean architecture; dependencies point strictly inward.

```
packages/concord/src/
├── domain/
│   ├── entities/        # Event, Run, Consumer — pure business values
│   ├── interactors/     # dispatch, replay, abort/restart, run input, auth, …
│   ├── exceptions/      # ConcordError hierarchy
│   ├── result.ts        # Result<T, E> (Rust-style)
│   └── ports/
│       ├── in/          # EventSink, Producer, Registrable, Registration (driving)
│       └── out/         # Rule, Handler, stores, registries, IdGenerator, Clock (driven)
├── infra/
│   ├── adapters/        # sqlite + in-memory stores, api, auth, github, git,
│   │                    # opencode, widgets, event templates, telegram, …
│   └── main/            # App, MakeApp, RegistrationContext (composition root)
├── server/              # startServer + composition contract + concord-server bin
└── cli/                 # handler-table CLI + concord bin
```

The domain depends only on language primitives and its own `Result`/error types.
The infra adapters depend on the domain ports they implement. `App` / `MakeApp`
are the outermost composition root and may depend on everything inward.

## License

MIT — see [LICENSE](./LICENSE).
