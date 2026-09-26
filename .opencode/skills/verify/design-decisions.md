# Design decisions
A PR can be correct and still unwanted, because it makes a design decision no human authorized. Separate implementation choices (always OK when consistent with an authorized issue) from design decisions (OK only when authorized — by a human or by a covering spec).

## Design decision vs implementation choice
A **design decision** changes what the system is or how it is structured at a level a stakeholder cares about: a new service, module, or major abstraction; an architecture or layering change; a new or changed public contract (API request/response, CLI shape, persisted data, event schema); a new system behavior; a new dependency, framework, or infrastructure resource. Design decisions require human authorization.

An **implementation choice** realizes an already-authorized design — helper names, internal data structures, control flow, variable decomposition — and needs no separate authorization, as long as it stays consistent with the issue.

## Authorized (safe to push)
A design decision is authorized if ANY holds:

1. The PR is authored by a human — a human choosing a design authorizes it; no issue needed.
2. A human-authored issue covers it (exclude usernames ending in `-bot` or `[bot]`).
3. A GitHub issue labeled `spec` covers it — regardless of who authored the issue.

### Why a bot-authored `spec` counts (rule 3)
In this repo a spec is the human-authorized design artifact. Specs are produced by the scope agent through human Q&A (it is told to make no assumptions and to validate every decision against the user), and the `spec` label is the marker that an issue went through that workflow. The scope agent often runs under a `-bot` username, so the author of a spec issue is whoever transcribed it — the authorization comes from the scoping process, not from the author's username. Excluding a spec because its author ends in `-bot` discards the authorization channel this repo relies on.

Rule 3 is scoped to the `spec` label. A bot-authored issue WITHOUT the `spec` label authorizes nothing, and rule 2's `-bot` exclusion still applies to every non-spec issue.

## Which issue governs when specs conflict
The most recent spec that covers a contract governs it. A newer spec that deliberately changes a contract SUPERSEDES the older spec that established the prior contract. The older spec is evidence of the prior state, not evidence against the change — never cite an older spec to reject a change that a newer spec authorizes. When the PR references a spec by number, that spec is the primary candidate for governing the change; check it before any other.

## Unauthorized (request changes)
A design decision is unauthorized when it is bot-introduced and no human-authored issue and no `spec`-labeled issue covers it. There is no human to escalate to, so the PR is rejected, not deferred — request changes and block the merge. Common cases:

- new service, top-level module, or major abstraction not in any issue;
- architecture or layering change beyond what an issue calls for;
- new dependency, framework, or infrastructure resource not justified by an issue;
- feature or behavior covered by no issue;
- change to an existing public contract no issue describes;
- rename or relocation of a public surface affecting callers outside the PR.

## Acceptable without an issue (not design decisions)
Bug fixes found during authorized work; test-reliability fixes that do not weaken assertions; build, CI, and pipeline fixes; docs accompanying code; lockfile bumps inside an approved range; behavior-preserving refactors. If any of these secretly alters architecture, contracts, or behavior, it becomes a design decision subject to the rules above.

## On failure
Name each unauthorized decision with its file(s) and hunk(s), list the issues checked, and state in one line why none cover it. The issues-checked list MUST include every issue the PR explicitly references (commit message `(#NNN)`, title, body, or GitHub "linked issues") — these are read first and never silently dropped. A spec is dropped from authorizing only if it does not cover the decision, never because of its author's username. Request changes.
