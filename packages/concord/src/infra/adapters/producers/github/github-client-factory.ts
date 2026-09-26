import type { GitHubClient } from "./github-client";
import { OctokitGitHubClient } from "./octokit-github-client";

export interface GitHubClientFactory {
  create(token: string): GitHubClient;
}

export class OctokitGitHubClientFactory implements GitHubClientFactory {
  public create(token: string): GitHubClient {
    return new OctokitGitHubClient(token);
  }
}
