---
name: project
description: ALWAYS LOAD. This skill contains information to get started with this project.
---
# Project Setup

## Workspaces

This repository is an npm workspace monorepo with two packages:

- `packages/concord` — `@walde.ai/concord`, the published package: the
  engine, the server bootstrap (`startServer`, `concord-server` bin), the
  CLI (`concord` bin), and the prebuilt dashboard bundle embedded at build
  time.
- `packages/ui` — the Vue dashboard. It is a build step only: `npm run
  build` compiles it and copies `packages/ui/dist` into
  `packages/concord/ui`, which is what the server serves by default and
  what npm ships. It is never published itself.

## Worktrees

This project can use git worktrees. All worktrees are located in the
`.worktree` folder within the project itself.

When asked, create a new worktree in the `.worktree` directory. This keeps
workspaces organized and allows you to switch between contexts easily.

## Setting up a fresh checkout or worktree

From the repository root:

```bash
npm install
npm run build
```

`npm run build` compiles the UI first, then the engine package (which
embeds the UI bundle). After it completes, both test suites can run:

```bash
npm test
```

## Spec workflow

Feature work is driven by specs in the `issues/` folder (see the `scope`
and `verifier` agents). Implementation happens on a dedicated branch per
spec and merges to `main` once verified.
