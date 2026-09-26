import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// The public tree (engine + UI) must contain no trace of the Walde
// deployment: no agent consumer ids, no walde-pipeline producer, no AWS
// identifiers, no spec/bugfix event definitions, no failure-notifier
// policy. This is the testable form of "nothing that operates Walde
// pipelines remains in the public tree".
const SCANNED_ROOTS = [
  join(__dirname, "..", "..", "concord", "src"),
  join(__dirname, "..", "..", "ui", "src"),
];

const FORBIDDEN_IDENTIFIERS: readonly string[] = [
  // agent consumer ids and module names
  "pipeline-fix",
  "merge-conflict-fix",
  "github-failure-fix",
  "pr-verify",
  "pr-rework",
  "pr-merge",
  "pr-publish",
  "spec-scope",
  "spec-implement",
  "bugfix-fix",
  "AgentConsumersFactory",
  // walde-pipeline producer suite
  "walde-pipeline",
  "WALDE_PIPELINE",
  "WaldePipelineProducer",
  "PIPELINE_STARTED",
  "PIPELINE_FAILED",
  "PipelineFailedPayload",
  "PipelineStartedPayload",
  // AWS identifiers
  "@aws-sdk",
  "CodePipeline",
  "aws-profile-resolver",
  "tshoot-walde-pipeline",
  "CONCORD_PIPELINE_AWS",
  // spec and bugfix event definitions and templates
  "SPEC_REQUEST",
  "SPEC_CREATED",
  "SPEC_IMPLEMENT_REQUEST",
  "SPEC_SCOPE_PRODUCER_ID",
  "BUGFIX_REQUEST",
  "BUGFIX_COMPLETED",
  "BUGFIX_FIX_PRODUCER_ID",
  "spec-event",
  "bugfix-event",
  "SpecRequestEventTemplate",
  "SpecImplementRequestEventTemplate",
  "BugfixRequestEventTemplate",
  // failure notifier policy
  "JobFailureNotifier",
  "CHAIN_CRITICAL_CONSUMERS",
  // pipeline widget id and payload kind
  "pipeline-status",
];

function listSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...listSourceFiles(full));
    } else if (entry.endsWith(".ts") || entry.endsWith(".vue")) {
      files.push(full);
    }
  }
  return files;
}

describe("engine purity", () => {
  it("the public engine and UI sources reference none of the moved identifiers", () => {
    const violations: string[] = [];
    for (const root of SCANNED_ROOTS) {
      for (const file of listSourceFiles(root)) {
        const content = readFileSync(file, "utf8");
        for (const identifier of FORBIDDEN_IDENTIFIERS) {
          if (content.includes(identifier)) {
            violations.push(`${file}: "${identifier}"`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
