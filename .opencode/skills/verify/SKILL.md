---
name: verify
description: LOAD WHEN VERIFYING a pull request before it merges to main. Checks PR incorrectness (bad code, bad practices, empty or stub PRs) and whether the design choices are human-authorized.
---
# Verify a Walde pull request
## Merge model
Feature branches merge directly to `main`. `main` triggers the production deployment pipeline, so a PR is the last gate before production. There is no `dev` branch.

Verification checks two independent axes, and BOTH must pass:

1. **Incorrectness** — the PR is broken, wrong, or empty: bad code, bad practices, stubs, placeholders, or no real change.
2. **Design choices** — every architecture, contract, or behavior decision in the diff is authorized (by a human or by a covering spec).

A pass on one axis never excuses a fail on the other.

## Authorization in one line
A design decision is authorized when the PR is authored by a human, when a human-authored issue covers it, or when a GitHub issue labeled `spec` covers it (a spec authorizes regardless of its author's username — specs are the human-driven scoping artifact). Bot-authored PRs are the common case where authorization must come from a covering issue or spec. Full rules in `design-decisions.md`.

## Workflow
1. **Read the diff and every linked issue.** Before judging, read every issue the PR explicitly references — commit-message `(#NNN)`, title, body, or GitHub "linked issues." A referenced `spec`-labeled issue is the primary authorization candidate and MUST be read and listed in the verdict; never silently drop it because the author ends in `-bot`. Understand what changes and why.
2. **Check incorrectness** against `incorrectness.md` — every file and hunk.
3. **Check design choices** against `design-decisions.md` — separate implementation choices from design decisions, and confirm each design decision is authorized.
4. **Post the verdict** per `reporting.md`.

Never approve a PR you have not read in full. If a hunk is undecidable, request changes rather than guess.

## Other files in this skill
```
.opencode/skills/verify
├── incorrectness.md       # the correctness bar
├── design-decisions.md    # which design choices are safe to push vs. unauthorized
├── reporting.md           # verdict format
└── SKILL.md
```
