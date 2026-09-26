import { access, constants } from "fs/promises";
import path from "path";

import { ConcordError } from "../../../domain/exceptions/errors";

/**
 * Resolves the absolute path of an executable by name. Used to decouple
 * `child_process.spawn` from `process.env.PATH`, which is frequently empty or
 * minimal when the server is launched by launchd/systemd/a parent process that
 * did not source a login shell. Without an absolute path, spawn fails with
 * `ENOENT` even when the binary is installed on the host.
 */
export interface BinaryResolver {
  resolve(name: string): Promise<string>;
}

/**
 * Well-known directories searched after `process.env.PATH`. Covers the standard
 * macOS, Homebrew (Intel + Apple Silicon), and Linux locations for the binaries
 * concord shells out to (`git`, `opencode`, `ssh`, ...).
 */
const FALLBACK_DIRS: readonly string[] = [
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
];

export class PathBinaryResolver implements BinaryResolver {
  private readonly cache: Map<string, string> = new Map();

  public constructor(
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly fallbackDirs: readonly string[] = FALLBACK_DIRS,
  ) {}

  public async resolve(name: string): Promise<string> {
    const cached = this.cache.get(name);
    if (cached !== undefined) {
      return cached;
    }
    const candidates = collectCandidates(name, this.env, this.fallbackDirs);
    for (const candidate of candidates) {
      if (await isExecutable(candidate)) {
        this.cache.set(name, candidate);
        return candidate;
      }
    }
    throw new BinaryNotFoundError(name, candidates);
  }
}

export class BinaryNotFoundError extends ConcordError {
  public constructor(
    public readonly binary: string,
    public readonly searched: readonly string[],
  ) {
    super(
      `Binary "${binary}" not found on PATH or fallback directories. Searched: ${
        searched.length > 0 ? searched.join(", ") : "(none)"
      }`,
    );
  }
}

/**
 * Builds a `process.env`-derived environment whose `PATH` is guaranteed to
 * contain the resolver's fallback directories. Spawned binaries (and their
 * grandchildren — e.g. `git` invoking `ssh`) inherit this env, so they too can
 * locate their own helpers even when the parent process had a broken PATH.
 */
export function robustSpawnEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
  fallbackDirs: readonly string[] = FALLBACK_DIRS,
): NodeJS.ProcessEnv {
  const dirs = [...pathDirs(baseEnv), ...fallbackDirs].filter(unique);
  return { ...baseEnv, PATH: dirs.join(path.delimiter) };
}

function collectCandidates(
  name: string,
  env: NodeJS.ProcessEnv,
  fallbackDirs: readonly string[],
): readonly string[] {
  if (path.isAbsolute(name)) {
    return [name];
  }
  return [...pathDirs(env), ...fallbackDirs].filter(unique).map((dir) => path.join(dir, name));
}

function pathDirs(env: NodeJS.ProcessEnv): readonly string[] {
  const value = env.PATH;
  if (typeof value !== "string" || value.length === 0) {
    return [];
  }
  return value.split(path.delimiter).filter((entry) => entry.length > 0);
}

function unique<T>(value: T, index: number, array: readonly T[]): boolean {
  return array.indexOf(value) === index;
}

async function isExecutable(target: string): Promise<boolean> {
  try {
    await access(target, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
