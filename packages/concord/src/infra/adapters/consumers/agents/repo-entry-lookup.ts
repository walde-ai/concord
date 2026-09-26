import type { ContextResolver } from "../../../../domain/ports/out/context-resolver";

import {
  GITHUB_REPOS_CONTEXT,
  isGithubReposContextPayload,
  type GithubRepoEntry,
} from "../../producers/github/github-repos-context";
import { parseRepoRef } from "../../producers/github/github-client";

/** Resolves the github-repos context into an entry list. Returns an empty
 * array when the context is missing or malformed: callers (the startup worktree
 * garbage collector) treat that as "nothing configured, nothing to do". */
export class RepoEntryLookup {
  public constructor(private readonly resolver: ContextResolver) {}

  public async listAll(): Promise<readonly GithubRepoEntry[]> {
    const result = await this.resolver.resolve(
      { kind: "consumer", id: "agent-consumers" },
      GITHUB_REPOS_CONTEXT,
      isGithubReposContextPayload,
    );
    if (!result.ok) {
      return [];
    }
    return result.value.context.repos;
  }

  public async find(owner: string, repo: string): Promise<GithubRepoEntry | null> {
    const result = await this.resolver.resolve(
      { kind: "consumer", id: "agent-consumers" },
      GITHUB_REPOS_CONTEXT,
      isGithubReposContextPayload,
    );
    if (!result.ok) {
      return null;
    }
    const entries = result.value.context.repos;
    for (const entry of entries) {
      let parsed;
      try {
        parsed = parseRepoRef(entry.url);
      } catch {
        continue;
      }
      if (parsed.owner === owner && parsed.repo === repo) {
        return entry;
      }
    }
    return null;
  }

  public async findByName(name: string): Promise<GithubRepoEntry | null> {
    const result = await this.resolver.resolve(
      { kind: "consumer", id: "agent-consumers" },
      GITHUB_REPOS_CONTEXT,
      isGithubReposContextPayload,
    );
    if (!result.ok) {
      return null;
    }
    const entries = result.value.context.repos;
    for (const entry of entries) {
      if (entry.name === name) {
        return entry;
      }
    }
    return null;
  }
}
