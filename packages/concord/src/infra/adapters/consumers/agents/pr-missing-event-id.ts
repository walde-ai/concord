import type { RepoRefDto } from "../../producers/github/pull-request";

export function prMissingEventId(repo: RepoRefDto, branch: string): string {
  return `${repo.owner}/${repo.repo}/branch/${branch}/pr.missing`;
}
