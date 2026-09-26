export const GITHUB_REPOS_CONTEXT = "github-repos";

export interface GithubRepoEntry {
  readonly name: string;
  readonly url: string;
  readonly local?: string;
  readonly worktrees?: string;
}

export interface GithubReposContextPayload {
  readonly repos: readonly GithubRepoEntry[];
}

export function isGithubReposContextPayload(value: unknown): value is GithubReposContextPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as { repos?: unknown };
  if (!Array.isArray(candidate.repos)) {
    return false;
  }
  return candidate.repos.every((entry) => isGithubRepoEntry(entry));
}

function isGithubRepoEntry(value: unknown): value is GithubRepoEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const entry = value as { name?: unknown; url?: unknown };
  return typeof entry.name === "string" && typeof entry.url === "string";
}
