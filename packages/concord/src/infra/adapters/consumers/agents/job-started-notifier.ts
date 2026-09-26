import type { Logger } from "../../../../domain/ports/out/logger";
import type { RepoRef } from "../../producers/github/github-client";
import type { ConsumerGitHubClientResolver } from "./consumer-github-client-resolver";

export interface JobStartedNotification {
  readonly consumerId: string;
  readonly repo: RepoRef;
  readonly prNumber: number;
}

export class JobStartedNotifier {
  public constructor(
    private readonly clientResolver: ConsumerGitHubClientResolver,
    private readonly logger: Logger,
  ) {}

  public async notify(notification: JobStartedNotification): Promise<void> {
    const { client } = await this.clientResolver.resolve(notification.consumerId);
    const body = `Concord: \`${notification.consumerId}\` job started`;
    try {
      await client.createIssueComment(notification.repo, notification.prNumber, body);
    } catch (cause) {
      this.logger.warn("job-started-notifier", "failed to post job-started comment", {
        consumerId: notification.consumerId,
        owner: notification.repo.owner,
        repo: notification.repo.repo,
        prNumber: notification.prNumber,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }
}
