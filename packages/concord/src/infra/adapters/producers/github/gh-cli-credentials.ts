import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { UnexpectedStateError } from "../../../../domain/exceptions/errors";
import type { GithubCredentials, GithubCredentialsProvider } from "./github-credentials";

const execFileAsync = promisify(execFile);

export class GhCliCredentialsProvider implements GithubCredentialsProvider {
  public async load(): Promise<GithubCredentials> {
    let stdout: string;
    try {
      const result = await execFileAsync("gh", ["auth", "token"]);
      stdout = result.stdout;
    } catch (cause) {
      throw new UnexpectedStateError(
        `Failed to read GitHub token via \`gh auth token\`: ${describeCause(cause)}`,
      );
    }

    const token = stdout.trim();
    if (token.length === 0) {
      throw new UnexpectedStateError(
        "GitHub token is empty; run `gh auth login` to authenticate first",
      );
    }
    return { token };
  }
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.message;
  }
  return String(cause);
}
