import type { ConsumerSecretResolver } from "../../../../domain/ports/out/consumer-secret-resolver";
import type { GitHubClient } from "../../producers/github/github-client";
import type { GitHubClientFactory } from "../../producers/github/github-client-factory";

export interface ResolvedGitHubIdentity {
  readonly client: GitHubClient;
  readonly token: string | null;
}

const GITHUB_TOKEN_SECRET_KEY = "githubToken";

export class ConsumerGitHubClientResolver {
  public constructor(
    private readonly secretResolver: ConsumerSecretResolver,
    private readonly factory: GitHubClientFactory,
    private readonly defaultClient: GitHubClient,
  ) {}

  public async resolve(consumerId: string): Promise<ResolvedGitHubIdentity> {
    const secrets = await this.secretResolver.resolveSecrets(consumerId);
    const token = secrets[GITHUB_TOKEN_SECRET_KEY];
    if (typeof token !== "string" || token.length === 0) {
      return { client: this.defaultClient, token: null };
    }
    return { client: this.factory.create(token), token };
  }
}
