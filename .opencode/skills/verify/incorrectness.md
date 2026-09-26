# Incorrectness
A PR must be substantively correct and complete. Fail any rule here with `request-changes`, regardless of design authorization.

## Substantive change required
A PR of only whitespace, comments, docs without code, lockfile churn, or that reverts itself empty, is not valid. After requested rework the PR must still contain meaningful changes — otherwise reject, do not approve.

## No stubs or deferred work
Every feature the PR claims (via linked issues, title, or description) must be fully implemented. Reject if required code contains:

- a function that throws "not implemented", returns a placeholder, or hardcodes a value standing in for logic;
- only types, interfaces, or skeletons with no behavior;
- tests for a feature whose implementation is missing;
- `TODO`/`FIXME`/`XXX`/`HACK` deferring the work the issue asks for.

Agents often scaffold and omit the real logic. Open every file, not just the diff summary.

## Bad code
Broken builds, imports, or type errors visible in the diff; logic contradicting the issue (inverted flag, off-by-one the issue's own example exposes); deleting error handling to make a call succeed; dead or copy-pasted code.

## Bad practices (Walde invariants — see the coding/architect skills)
- **Silenced errors** — empty or broadened catch, errors turned into log lines, swallowed without rethrow or handling.
- **Weakened tests** — relaxed assertions, newly skipped tests, expected-to-fail added to turn red green. Local (fully-mocked) tests must have no newly skipped test.
- **`console.log`** instead of the `Logger` port.
- **Assumed defaults** — `|| fallback` hiding missing input, silent `null`, defalting to values (except in composition) instead of explicitly requiring them from the user
- **Broken Clean Architecture** — domain depending on infrastructure, interactors returning entities, a concrete dependency where an interface is required.
- **Unfaithful mocks** — a mock altered to pass a test in a way that diverges from the real API the contract tests pin.

## On failure
Quote the file, line, and code; name the rule broken; for incomplete work, name the unmet issue requirement. Request changes; do not partially approve.
