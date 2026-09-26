import type { Logger } from "../../../../domain/ports/out/logger";
import type { GithubCredentialsProvider } from "./github-credentials";
import { GhCliCredentialsProvider } from "./gh-cli-credentials";
import { OctokitGitHubClient } from "./octokit-github-client";
import type { PullRequestLifecycleStore } from "./pull-request-lifecycle-store";
import { InMemoryPullRequestLifecycleStore } from "./in-memory-pull-request-lifecycle-store";
import { GithubPrProducer } from "./github-producer";

const DEFAULT_POLL_INTERVAL_MS = 10_000;

export class GithubPrProducerFactory {
  public constructor(
    private readonly credentialsProvider: GithubCredentialsProvider,
    private readonly logger: Logger,
    private readonly lifecycleStore: PullRequestLifecycleStore | null = null,
  ) {}

  public async create(): Promise<GithubPrProducer> {
    const credentials = await this.credentialsProvider.load();
    const client = new OctokitGitHubClient(credentials.token);
    // Reuse a caller-provided (durable) store when available so PR lifecycle
    // state survives a server restart; fall back to an in-memory store for
    // standalone/library use. A non-durable store makes the producer re-emit
    // pr.opened for every open PR on each startup.
    const store = this.lifecycleStore ?? new InMemoryPullRequestLifecycleStore();
    return new GithubPrProducer(client, store, DEFAULT_POLL_INTERVAL_MS, this.logger);
  }
}

export {
  GhCliCredentialsProvider,
  DEFAULT_POLL_INTERVAL_MS,
};
