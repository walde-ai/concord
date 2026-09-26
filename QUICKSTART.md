# Concord — Quickstart & Operator Guide

This document is the **single source of truth for an agent or a human** to take a
fresh machine from zero to a running, fully-configured Concord installation.

Everything in this guide is driven from the CLI (`packages/concord`). No SQL, no HTTP
calls, no manual file editing is required. The CLI talks **directly to the SQLite
database** for every administrative operation, so it works unauthenticated on the
host that runs the server. Remote/authenticated operation is supported for the
two commands that talk to a live server (`event emit`, `context upsert` without
`--local`).

> Read this document top to bottom the first time. Each later section links back
> to the CLI commands it depends on. If your goal is to build an agent-driven
> software factory on top of Concord (PR verification loops, fix agents, spec
> flows), read [`SOFTWARE_FACTORY.md`](./SOFTWARE_FACTORY.md) after section 7 —
> it turns the pieces configured here into a working factory.

---

## 1. Repository layout

```
concord/                         monorepo root
├── package.json                 workspace root, exposes `npm run` shortcuts
├── packages/
│   ├── concord/                 @walde.ai/concord — the published package: the
│   │                            engine (domain + adapters), the server bootstrap
│   │                            (`startServer`, `concord-server` bin), the admin
│   │                            CLI (`concord` bin) and the prebuilt dashboard
│   │                            bundle embedded at build time
│   └── ui/                      @walde.ai/concord-ui — Vue dashboard (build
│                                step only; the bundle is embedded into
│                                @walde.ai/concord and never published itself)
├── issues/                      specs for the feature workflow
├── SOFTWARE_FACTORY.md          guide: build an agent-driven factory on Concord
└── README.md                    architectural overview of the library
```

The CLI is shipped by `@walde.ai/concord` as the `concord` binary
(`packages/concord/dist/cli/bin/concord.js`). Dispatch is a handler table in
`packages/concord/src/cli/main/run-command.ts`; deployments can extend it with
extra noun/verb handlers through the exported `runCli` runner.

---

## 2. Build & install


### 2.1 Prerequisites

- Node.js 20+ (for `fs.cp`, `fetch`, and `WebSocket` globals)
- `npm` (workspaces are used)
- `git` (for the GitHub PR producer and the worktree-based agent runners)
- The `gh` CLI, logged in (`gh auth login`), used by `GhCliCredentialsProvider`
  to obtain a GitHub token for the PR producer. Run `gh auth status` to verify.
- [opencode](https://opencode.ai) on `PATH`, with a model provider configured,
  if you use the agent runner (`AgentTaskRunner`).

### 2.2 First-time install (from a fresh worktree)

From the repo root:

```bash
npm install                 # installs every workspace + links the local packages
npm run build               # builds the UI, then the engine (embeds the bundle)
```

### 2.3 Building

```bash
npm run build               # builds ui → concord (embeds the UI bundle)
```

### 2.4 Running the CLI without a global install

Two equivalent ways; pick whichever fits your script:

```bash
# (a) via the workspace shortcut — note the trailing `--`
npm run cli -- peak-hours get

# (b) via node directly against the built binary
node packages/concord/dist/cli/bin/concord.js peak-hours get
```

The rest of this document uses the canonical form `concord ...` to keep examples
short. Treat each occurrence as one of the two forms above.

### 2.5 Useful environment variables (all commands)

| Variable | Default | Applies to | Purpose |
| --- | --- | --- | --- |
| `CONCORD_DATABASE_PATH` | `.concord/concord.db` | every command | Path to the SQLite database. Set this once in the service unit and in the shell that runs the CLI so both sides agree. |
| `CONCORD_API_HOST` | `127.0.0.1` | server + HTTP CLI commands | Host the server listens on / the CLI dials. |
| `CONCORD_API_PORT` | `3000` | server + HTTP CLI commands | Port the server listens on / the CLI dials. |
| `CONCORD_USERNAME` | — | `event emit`, `context upsert` (HTTP mode) | Username for SRP login. |
| `CONCORD_PASSWORD` | — | same | Password (prompted interactively if unset). |
| `CONCORD_ARGON2_MEMORY_COST` / `_TIME_COST` / `_PARALLELISM` | OWASP defaults | `user create` only | Override Argon2id parameters. Don't change unless you know what you're doing. |

Every flag below also accepts `--database <path>` as an explicit override of
`CONCORD_DATABASE_PATH`, evaluated after the env var.

---

## 3. The database, and how the CLI reaches it

Concord stores everything — events, runs, users, contexts, peak hours, pause
state, consumer configs and secrets, producer/consumer enabled flags — in a
single SQLite file at `$CONCORD_DATABASE_PATH`.

The CLI opens its own short-lived connection to that file for each invocation.
**It does not need the server to be running**, and **it never authenticates**.
This is by design: configuration commands are administrative and must work on a
fresh host where no user exists yet.

> Run CLI commands on the same host that runs the server, against the same
> `CONCORD_DATABASE_PATH`. If you mount the database over NFS / a network share,
> make sure SQLite's WAL mode does not corrupt — for production, keep the file
> on local disk.

### 3.1 Two CLI modes at a glance

| Mode | When to use | Auth |
| --- | --- | --- |
| **Local mode** (default for every command in this guide unless noted) | Run on the server host. Reads/writes SQLite directly. | None. The filesystem IS the trust boundary. |
| **HTTP mode** (`event emit`, `context upsert` without `--local=true`) | Run from a remote workstation, against a running server. | SRP login + HMAC-signed requests. Requires `--username` and `--password`. |

---

## 4. First-time setup (empty database → first user)

This is the bootstrap path. There is no authentication yet, so it MUST be run on
the server host via local mode.

### 4.1 Initialise the database

`MakeApp()` (called by the server) creates the schema on startup. You can either
start the server once to let it create the file, or create it explicitly from the
CLI with any command — the SQLite driver runs the DDL on first open:

```bash
export CONCORD_DATABASE_PATH=/var/lib/concord/concord.db
concord pause get   # any local command will create + migrate the file
```

The directory is created automatically. Confirm:

```bash
ls -lh "$CONCORD_DATABASE_PATH"
```

### 4.2 Create the first (admin) user

```bash
concord user create --name admin --password "<a strong password>"
```

Output: `{"username":"admin"}`. There is no concept of admin vs. non-admin
users; any user that can authenticate against the HTTP API can call every
endpoint. Restrict who you create.

The password is hashed with Argon2id (OWASP parameters by default) and stored
as an SRP verifier. The password itself is never stored and never sent over the
wire in plaintext — `event emit` / `context upsert` (HTTP mode) use the SRP-6a
handshake to derive a shared session key.

### 4.3 Delete a user

```bash
concord user delete --name admin
```

### 4.4 Verify the bootstrap

A quick sanity check that the HTTP API is reachable and the new user can log in:

```bash
# 1. start the server (see §5) in the background, then:
concord event emit \
  --username admin --password "<the same password>" \
  --type bootstrap.check --payload '{"ok":true}'
```

You should receive a JSON event descriptor with `producerId: "cli"`. If you see
`401 invalid credentials`, the username/password do not match what's stored.

---

## 5. Running the server

### 5.1 Foreground (development)

From the repo root:

```bash
npm run dev
```

This starts the server and the Vue UI concurrently. Defaults:

- API: `http://127.0.0.1:3000`
- UI: printed by Vite (usually `http://localhost:5173`)

For just the API:

```bash
npm run dev --workspace packages/ui
```

### 5.2 Production build + foreground run

```bash
npm run build
npm start
```

`concord-server` honours the env vars in §2.5. Minimal production invocation:

```bash
CONCORD_API_HOST=127.0.0.1 \
CONCORD_API_PORT=3000 \
CONCORD_DATABASE_PATH=/var/lib/concord/concord.db \
node packages/concord/dist/server/main.js
```

### 5.3 As a service (launchd, macOS)

Create `/Library/LaunchDaemons/ai.walde.concord.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>ai.walde.concord</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/opt/concord/packages/concord/dist/server/main.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CONCORD_API_HOST</key><string>127.0.0.1</string>
    <key>CONCORD_API_PORT</key><string>3000</string>
    <key>CONCORD_DATABASE_PATH</key><string>/var/lib/concord/concord.db</string>
    <key>PATH</key><string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/var/log/concord.log</string>
  <key>StandardErrorPath</key><string>/var/log/concord.err.log</string>
</dict>
</plist>
```

Then:

```bash
sudo launchctl bootstrap system /Library/LaunchDaemons/ai.walde.concord.plist
sudo launchctl enable system/ai.walde.concord
tail -f /var/log/concord.log
```

To stop / restart:

```bash
sudo launchctl bootout system /Library/LaunchDaemons/ai.walde.concord.plist   # stop + unload
sudo launchctl kickstart -k system/ai.walde.concord                          # restart
```

### 5.4 As a service (systemd, Linux)

`/etc/systemd/system/concord.service`:

```ini
[Unit]
Description=Concord event-driven workflow engine
After=network-online.target

[Service]
Type=simple
User=concord
Group=concord
WorkingDirectory=/opt/concord
Environment=CONCORD_API_HOST=127.0.0.1
Environment=CONCORD_API_PORT=3000
Environment=CONCORD_DATABASE_PATH=/var/lib/concord/concord.db
ExecStart=/usr/bin/node /opt/concord/packages/concord/dist/server/main.js
Restart=on-failure
RestartSec=3
StandardOutput=append:/var/log/concord.log
StandardError=append:/var/log/concord.err.log

[Install]
WantedBy=multi-user.target
```

Then:

```bash
sudo useradd --system --home /var/lib/concord --shell /usr/sbin/nologin concord
sudo install -d -o concord -g concord /var/lib/concord /var/log
sudo cp -R . /opt/concord && cd /opt/concord && npm ci --omit=dev && npm run build
sudo systemctl daemon-reload
sudo systemctl enable --now concord
journalctl -u concord -f
```

### 5.5 Reverse proxy (optional)

The HTTP API and the WebSocket `/api/stream` are served from the same port. Put
nginx / Caddy in front if you need TLS. Make sure the proxy upgrades the
`/api/stream` connection (nginx: `proxy_http_version 1.1` + `Upgrade` /
`Connection` headers, plus `proxy_read_timeout` of at least `3600s`).

---

## 6. Configuration overview

After bootstrap, configuration falls into four buckets:

| Bucket | What's in it | CLI command family |
| --- | --- | --- |
| **Contexts** | Named JSON blobs + secret maps that producers and consumers resolve at runtime. The best-known name is `github-repos` (which repos the GitHub PR producer targets); your own producers and consumers can define their own. | `context upsert --local=true` |
| **Consumer config & secrets** | Per-consumer key/value pairs (`modelId`, `agentName`) and secret values (`githubToken`). | `consumer-config set`, `consumer-secret set/delete` |
| **Peak hours & off-peak** | A single `PeakHours` window (HH:MM + IANA zone). Consumers opt in to off-peak deferral individually. | `peak-hours get/set/clear`, `consumer-off-peak set` |
| **Pause & enabled flags** | A global pause that stops ALL event dispatch, plus per-producer and per-consumer enable bits. | `pause get/set`, `consumer enable/disable`, `producer enable/disable` |

All four buckets are persisted in the same SQLite file and read live by the
running server — **no restart is needed for any of them to take effect**, except
changes that only the CLI sees on disk while the server was offline (those take
effect at next server start).

---

## 7. Defining the target repos

The GitHub PR producer (`github-pr`) reads a context named **`github-repos`**.
Each entry tells the producer which repository to poll and (optionally) where
its local clone lives so agent runners can use a worktree from that path.

```bash
concord context upsert --local=true \
  --name github-repos \
  --content '{
    "repos": [
      {"name":"concord","url":"https://github.com/your-org/your-repo"},
      {"name":"docs","url":"https://github.com/your-org/your-docs","local":"/srv/repos/your-docs"}
    ]
  }' \
  --secrets '{"ghPat":"ghp_xxxxxxxxxxxxxxxx"}'
```

Schema (see `GithubReposContextPayload`):

| Field | Required | Notes |
| --- | --- | --- |
| `repos[].name` | yes | Short identifier used in logs and event payloads. |
| `repos[].url` | yes | `https://github.com/<owner>/<repo>` — parsed to obtain `owner`/`repo`. |
| `repos[].local` | no | Absolute path to a local clone. When present, agent runners create git worktrees under this path instead of cloning from the URL. |
| `repos[].worktrees` | no | Reserved for future explicit worktree root overrides. |

`--content` and `--secrets` accept either inline JSON or `@<path>` to a file
holding JSON. Use `@` for any non-trivial payload:

```bash
concord context upsert --local=true \
  --name github-repos \
  --content @/etc/concord/github-repos.json \
  --secrets @/etc/concord/github-secrets.json
```

To update without clobbering existing secrets, just call again — secrets are
merged, not replaced:

```bash
concord context upsert --local=true --name github-repos \
  --content @/etc/concord/github-repos.json \
  --secrets '{"ghPat":"ghp_new_token"}'   # only ghPat is overwritten
```

## 8. Peak hours, off-peak, and per-consumer deferral

Concord has **one global peak-hours window**. Any consumer can be marked as
`waitForOffPeak: true`; when such a consumer's run is dispatched during peak,
the run is parked and re-tried once the off-peak window opens.

### 8.1 Read / set / clear the global window

```bash
# read
concord peak-hours get
# {"peakHours":null}          <- no window configured, peak-deferral is inert

# set (start/end are HH:MM 24-hour, timezone is any IANA zone)
concord peak-hours set --start 09:00 --end 18:00 --timezone Europe/Berlin
# {"peakHours":{"start":"09:00","end":"18:00","timezone":"Europe/Berlin"}}

# clear (disable peak-deferral globally)
concord peak-hours clear
# {"cleared":true}
```

Validation matches the HTTP API:

- `--start` and `--end` must match `^([01]\d|2[0-3]):[0-5]\d$`.
- `--timezone` must be accepted by `Intl.DateTimeFormat` (any IANA zone, e.g.
  `Europe/Berlin`, `America/Los_Angeles`, `UTC`).

### 8.2 Opt a consumer in to off-peak

```bash
concord consumer-off-peak set --id heavy-worker --value true
# {"consumerId":"heavy-worker","waitForOffPeak":true}

concord consumer-off-peak set --id heavy-worker --value false   # opt back out
```

### 8.3 How it interacts with pause

Pause (§9) is a hard stop: when paused, **no** events are dispatched, peak or
off-peak. Pause always wins. Off-peak only reschedules peak-hour work; it never
triggers work on its own.

---

## 9. Pause and per-component enable bits

### 9.1 Global pause

`pause set --paused true` parks the entire dispatcher. Producers keep running
(they will still emit events into the store), but no consumer runs are
started until you clear it.

```bash
concord pause set --paused true     # stop dispatching
concord pause get                    # {"paused":true}
concord pause set --paused false    # resume
```

Use this for safe maintenance windows: pause, do your work on the host, then
unpause. Pending events accumulate in `events` table and dispatch on resume.

### 9.2 Per-producer enable

Producers registered by your composition can be disabled individually so the
server stops polling them (using the GitHub PR producer as the example):

```bash
concord producer disable --id github-pr
concord producer enable  --id github-pr
```

The system producers (`concord`, `concord.replay`, `web-ui`, `cli`) are not
disableable; attempts to disable them are persisted but the server ignores the
flag for those IDs.

### 9.3 Per-consumer enable

Per-consumer enable bits control whether the dispatcher will start a run for
that consumer when its rule matches. the right lever for "turn off just
a single consumer while leaving everything else running":

```bash
concord consumer disable --id heavy-worker
concord consumer enable  --id heavy-worker
```

Disabled consumers still appear in `GET /api/consumers` with
`enabled: false`. Their config and secrets are untouched.

### 9.4 Lifecycle cheatsheet

| Lever | Scope | What stops |
| --- | --- | --- |
| `pause set --paused true` | global | all dispatching; producers keep emitting into the store |
| `producer disable --id <id>` | one producer | that producer's polling; existing events already in the store still dispatch |
| `consumer disable --id <id>` | one consumer | that consumer's runs; everything else keeps flowing |
| `consumer-off-peak set --value true` | one consumer | that consumer's peak-hour runs (deferred, not stopped) |

---

## 10. CLI reference (canonical form)

Every command below is `noun verb [--flag value | --flag=value]...`. Flags that
accept JSON also accept `@<path>` to load from a file. `--database <path>` is
accepted by every local command and overrides `CONCORD_DATABASE_PATH`.

```
concord user create --name <str> --password <str>
concord user delete --name <str>

concord event emit --type <str> --payload <json|@file>
                   [--username <str>] [--password <str>]            # HTTP mode (auth)

concord context upsert --name <str> --content <json|@file>
                       [--secrets <json|@file>]
                       [--local=true]                               # --local=true => SQLite, no auth
                       [--username <str>] [--password <str>]        # used when --local is absent

concord peak-hours get
concord peak-hours set --start HH:MM --end HH:MM --timezone <IANA>
concord peak-hours clear

concord pause get
concord pause set --paused <true|false>

concord consumer-config set    --id <consumerId> --values <json|@file>
concord consumer-secret set    --id <consumerId> --secrets <json|@file>
concord consumer-secret delete --id <consumerId> --names <a,b,c>
concord consumer-off-peak set  --id <consumerId> --value <true|false>

concord consumer enable  --id <consumerId>
concord consumer disable --id <consumerId>
concord producer enable  --id <producerId>
concord producer disable --id <producerId>
```

Notes on flag syntax:

- The argv parser treats every `--flag` as a key/value pair. Bare boolean flags
  like `--local` are NOT supported; always write `--local=true` (or `--local 1`).
  For `pause set --paused` and `consumer-off-peak set --value`, the value is
  required and must be `true` or `false`.
- Local commands write to SQLite immediately and close the connection before
  returning. They never need the server to be up.
- All commands print a single JSON line on stdout on success and exit `0`.
  Argv errors exit `2`; runtime errors exit `1` with a message on stderr.

---

## 11. Day-2 operations cookbook

| Goal | Commands |
| --- | --- |
| Rotate the admin password | `concord user delete --name admin && concord user create --name admin --password "<new>"` |
| Stop everything safely | `concord pause set --paused true`, wait for in-flight runs to drain, then `systemctl --user stop concord` |
| Resume after maintenance | restart the service, then `concord pause set --paused false` |
| Move peak window for the holidays | `concord peak-hours set --start 00:00 --end 23:59 --timezone Europe/Berlin` (or `peak-hours clear`) |
| Add a new repo to track | `concord context upsert --local=true --name github-repos --content @repos.json` (secrets merge automatically) |
| Inspect current state without HTTP | open `$CONCORD_DATABASE_PATH` in the `sqlite3` CLI; every table is named in `SqliteDatabase.SCHEMA_DDL` |

---

## 12. Troubleshooting

**`concord user create` on a fresh host fails with `SQLITE_CANTOPEN`.**
The directory of `CONCORD_DATABASE_PATH` is not writable by the current user.
`mkdir -p $(dirname "$CONCORD_DATABASE_PATH")` and `chown` it.

**`event emit` returns `401 invalid credentials`.**
Either the user doesn't exist (`concord user create`), the password is wrong, or
the CLI is hitting a different server than the one with your user. Confirm
`CONCORD_API_HOST` / `CONCORD_API_PORT` and `CONCORD_DATABASE_PATH` match.

**`context upsert --local=true` is parsed as `--name` missing.**
You wrote a bare `--local`. The parser needs `--local=true` (or `--local 1`).
See §10.

**Producers / consumers don't appear.**
The server only registers them at startup. If you change `gh auth` after
starting the server, restart it. A producer your composition registers is
skipped with a log line explaining why (for example, missing credentials).

**Peak deferral seems to do nothing.**
Two requirements: (1) the global window is set (`peak-hours get` is non-null),
and (2) the consumer is opted in (`consumer-off-peak set --value true`). Both
must be true for a given consumer to defer.

---

## 13. Where to look in the source

| Topic | File |
| --- | --- |
| CLI dispatcher | `packages/concord/src/cli/main/run-command.ts` |
| Argv parsing rules | `packages/concord/src/cli/args/argv-parser.ts` |
| Local-mode composition (SQLite) | `packages/concord/src/cli/main/local-compose.ts` |
| HTTP-mode composition (SRP) | `packages/concord/src/cli/main/compose.ts` |
| Server bootstrap + env vars | `packages/concord/src/server/start-server.ts` |
| HTTP API surface | `packages/concord/src/infra/adapters/api/http-api-server.ts` |
| SQLite schema + migrations | `packages/concord/src/infra/adapters/stores/sqlite/sqlite-database.ts` |
| Agent consumer schema | `packages/concord/src/infra/adapters/consumers/agents/agent-config-schema.ts` |
| `github-repos` context shape | `packages/concord/src/infra/adapters/producers/github/github-repos-context.ts` |
| Library architecture overview | `README.md` |
