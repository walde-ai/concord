// A check suite is GitHub's grouping for a single workflow run; GitHub Actions
// creates one as soon as a workflow is triggered for a commit, before any of
// its check runs exist. The producer uses the presence of these suites to tell
// "this commit has Actions configured but the runs have not started yet" apart
// from "this repository has no Actions configured at all".
//
// The field types mirror the GitHub REST schema for "check-suite": both status
// and conclusion are nullable there (status can be null while Actions is still
// deciding whether to schedule the suite), so both are nullable here too.
export class CheckSuite {
  public constructor(
    public readonly status: string | null,
    public readonly conclusion: string | null,
  ) {}
}

