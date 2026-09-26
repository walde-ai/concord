# Scope Verification Skill

This skill performs scope verification on PRs from dev to main, checking for unauthorized changes and ensuring substantive implementation.

## Task

Perform scope verification on PR #${prNumber} in repository ${repo}.

## Verification Steps

1. Read the full diff: `gh pr diff ${prNumber} --repo ${repo}`
2. Check author: `gh pr view ${prNumber} --repo ${repo} --json author --jq '.author.login'`
3. List issues: `gh issue list --repo ${repo} --state all --limit 50`
4. For each issue, read details: `gh issue view <number> --repo ${repo}`
5. Filter to human-authored issues only (exclude usernames ending with '-bot' or '[bot]')
6. Cross-reference every change against human-authored GitHub Issues

## Human Authors vs Bots

A GitHub user is a **human** if their username does NOT end with '-bot' or '[bot]'.
A GitHub user is a **bot** if their username ends with '-bot' or '[bot]'.

Human authors are trusted to introduce design changes and new features even without a corresponding GitHub Issue. If the PR was authored by a human, any new architectural decisions, design patterns, or system behaviors they introduce are acceptable — scope is automatically considered clean.

If the PR was authored by a bot, additional tracing is required.

## Tracing Bot PRs to Human Origin

When the PR was authored by a bot, check if changes originated from a human who directly committed to dev or opened a PR into dev:

7. List recent dev PRs: `gh pr list --repo ${repo} --base dev --state merged --limit 50 --json number,author,title,mergedAt`
8. List recent dev commits: `gh api "/repos/${repo}/commits?sha=dev&per_page=50" --jq '.[].author.login'`
9. For design changes, check if a human-authored PR into dev or commit on dev introduced the same change
10. If traceable to human, it's acceptable — the human originated it

## What Constitutes Scope Creep

Flag changes that introduce NEW ARCHITECTURAL DECISIONS, NEW DESIGN PATTERNS, or NEW SYSTEM BEHAVIORS not covered by:
- A human-authored issue
- Direct authorship by a human on this PR
- A human-authored PR into dev
- A commit on dev authored by a human

Examples:
- Adding a new service, module, or major abstraction not requested
- Changing architecture or design beyond what an issue calls for
- Introducing new dependencies or frameworks not justified
- Adding features not covered by any issue or human-authored work

## What Is Acceptable Without an Issue

These changes are acceptable even without a specific issue, as long as they don't alter architecture or design:
- Bug fixes discovered during development
- Test reliability improvements (retries, race condition fixes)
- Build and pipeline fixes for CI
- Documentation updates accompanying code changes
- Dependency lock file updates
- Refactoring that simplifies code without changing behavior

## Full Implementation Required for Bot PRs

When the PR was authored by a bot, verify that every feature required by linked issues is FULLY IMPLEMENTED — not stubbed, scaffolded, or partial.

A bot-authored PR is incomplete if:
- A function throws "not implemented" or returns a placeholder
- Implementation only has types/interfaces/skeletons without real logic
- Tests exist but underlying feature is not implemented
- TODO/FIXME comments indicate deferred work

This rule exists because agents sometimes scaffold structure but omit real business logic. You must catch this for bot-to-main PRs.

If the PR replicates human work from dev into main, still verify the implementation is substantive, not a stub.

Be thorough. Review every file and hunk in the diff.

## CRITICAL: PR Must Introduce a Substantive Change

A PR MUST introduce actual, substantive code changes. A PR that:
- Contains only whitespace or formatting changes
- Reverts all changes to become effectively empty
- Contains only comments or documentation without code changes
- Contains only placeholder or stub code

...is NOT acceptable and should NOT be approved for merge.

When scope verification requests rework:
- The fix MUST address the identified issues
- The resulting PR MUST still contain substantive changes
- An empty or near-empty PR is grounds for rejection, not approval

If a PR after rework has no meaningful changes remaining, the verdict should be that the PR needs attention and cannot proceed.

## Output

Return a structured scope verdict following the format specified by the formatScopeVerdictRequest function.