# Reporting
Post the verdict as a PR review. The review is the only durable record, so a reader must reproduce your decision from it alone.

## Outcomes
- **Approve** — passes both incorrectness and design choices.
- **Request changes** — fails incorrectness, or contains an unauthorized design decision. There is no human escalation: a bot-introduced design decision that no human authorized is rejected, not deferred.

The axes are independent: a pass on design does not excuse a stub; clean code does not authorize an unwanted design decision. When they disagree, always request changes.

## Body
- **Verdict** — `approved` or `changes-requested`, first line.
- **Incorrectness** — one line if clean; otherwise one block per problem with file, line, quoted code, and the rule broken.
- **Design choices** — one line if all authorized (name the human author or covering issue(s)/spec(s)); otherwise one block per unauthorized decision with file(s)/hunk(s), issues checked, and why none cover it. The issues-checked list MUST include every issue the PR explicitly references; a `spec`-labeled issue is never excluded for its author's username.

Quote code and paths; never paraphrase a problem into vagueness. You approve or request changes; you do not merge.
