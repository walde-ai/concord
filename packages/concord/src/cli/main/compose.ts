import { Argon2PasswordSecretDeriver, OWASP_ARGON2ID_PARAMETERS, TEST_ARGON2ID_PARAMETERS, type Argon2Parameters } from "../../infra/adapters/auth/argon2-password-secret-deriver";
import { SecureRemotePasswordIssuer } from "../../infra/adapters/auth/secure-remote-password-issuer";
import { SqlitePersistenceFactory, type SqlitePersistenceBundle } from "../../infra/adapters/stores/sqlite/sqlite-persistence-factory";

export interface UserCommandDeps {
  readonly bundle: SqlitePersistenceBundle;
  readonly issuer: SecureRemotePasswordIssuer;
  readonly deriver: Argon2PasswordSecretDeriver;
}

export function resolveDatabasePath(): string {
  const env = process.env.CONCORD_DATABASE_PATH;
  if (env !== undefined && env.length > 0) {
    return env;
  }
  return ".concord/concord.db";
}

export function resolveArgon2Parameters(): Argon2Parameters {
  const memoryCost = process.env.CONCORD_ARGON2_MEMORY_COST;
  const timeCost = process.env.CONCORD_ARGON2_TIME_COST;
  const parallelism = process.env.CONCORD_ARGON2_PARALLELISM;
  if (memoryCost === undefined && timeCost === undefined && parallelism === undefined) {
    return OWASP_ARGON2ID_PARAMETERS;
  }
  return {
    memoryCost: memoryCost !== undefined ? Number(memoryCost) : OWASP_ARGON2ID_PARAMETERS.memoryCost,
    timeCost: timeCost !== undefined ? Number(timeCost) : OWASP_ARGON2ID_PARAMETERS.timeCost,
    parallelism: parallelism !== undefined ? Number(parallelism) : OWASP_ARGON2ID_PARAMETERS.parallelism,
  };
}

export function buildUserCommandDeps(
  databasePath: string,
  params: Argon2Parameters = resolveArgon2Parameters(),
): UserCommandDeps {
  const factory = new SqlitePersistenceFactory(databasePath);
  const bundle = factory.create();
  const deriver = new Argon2PasswordSecretDeriver(params);
  const issuer = new SecureRemotePasswordIssuer(deriver);
  return { bundle, issuer, deriver };
}

export function resolveApiOrigin(): string {
  const host = process.env.CONCORD_API_HOST ?? "127.0.0.1";
  const port = process.env.CONCORD_API_PORT ?? "3000";
  return `http://${host}:${port}`;
}

export function resolveUsername(flag: string | undefined): string {
  const fromFlag = flag;
  if (fromFlag !== undefined && fromFlag.length > 0) {
    return fromFlag;
  }
  const fromEnv = process.env.CONCORD_USERNAME;
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return fromEnv;
  }
  throw new Error("username is required: pass --username or set CONCORD_USERNAME");
}

export async function resolvePassword(flag: string | undefined): Promise<string> {
  if (flag !== undefined && flag.length > 0) {
    return flag;
  }
  const fromEnv = process.env.CONCORD_PASSWORD;
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return fromEnv;
  }
  return promptHidden("Password: ");
}

function promptHidden(prompt: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const isTty = process.stdin.isTTY;
    process.stdout.write(prompt);
    if (isTty === true) {
      process.stdin.setRawMode(true);
    }
    let value = "";
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        const code = ch.charCodeAt(0);
        if (code === 13 || code === 10) {
          cleanup();
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (code === 3 || code === 4) {
          cleanup();
          process.stdout.write("\n");
          reject(new Error("interrupted"));
          return;
        }
        if (code === 127 || code === 8) {
          if (value.length > 0) {
            value = value.slice(0, -1);
          }
          continue;
        }
        if (code >= 32) {
          value += ch;
        }
      }
    };
    const cleanup = (): void => {
      process.stdin.removeListener("data", onData);
      process.stdin.pause();
      if (isTty === true) {
        process.stdin.setRawMode(false);
      }
    };
    process.stdin.on("data", onData);
  });
}
