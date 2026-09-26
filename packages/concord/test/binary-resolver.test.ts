import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync } from "fs";
import { tmpdir } from "os";
import path from "path";

import { PathBinaryResolver, BinaryNotFoundError, robustSpawnEnv } from "../src/infra/adapters/system/binary-resolver";

function makeExecutable(name: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "concord-bin-"));
  const target = path.join(dir, name);
  writeFileSync(target, "#!/bin/sh\nexit 0\n");
  chmodSync(target, 0o755);
  return target;
}

describe("PathBinaryResolver.resolve", () => {
  it("resolves a binary found in process.env.PATH", async () => {
    const binDir = path.dirname(makeExecutable("found-tool"));
    const resolver = new PathBinaryResolver({ PATH: binDir }, []);
    const resolved = await resolver.resolve("found-tool");
    expect(resolved).toBe(path.join(binDir, "found-tool"));
  });

  it("falls back to the well-known directories when PATH is empty", async () => {
    const resolver = new PathBinaryResolver({ PATH: "" });
    // git ships at /usr/bin/git on macOS and most Linux distros.
    const resolved = await resolver.resolve("git");
    expect(path.isAbsolute(resolved)).toBe(true);
    expect(resolved.endsWith("git")).toBe(true);
  });

  it("falls back when PATH is unset entirely", async () => {
    const resolver = new PathBinaryResolver({});
    const resolved = await resolver.resolve("git");
    expect(path.isAbsolute(resolved)).toBe(true);
  });

  it("caches the resolved path across calls", async () => {
    const binDir = path.dirname(makeExecutable("cached-tool"));
    const resolver = new PathBinaryResolver({ PATH: binDir }, []);
    const first = await resolver.resolve("cached-tool");
    const second = await resolver.resolve("cached-tool");
    expect(first).toBe(second);
  });

  it("returns the absolute path as-is when the name is already absolute", async () => {
    const target = makeExecutable("absolute-tool");
    const resolver = new PathBinaryResolver({}, []);
    const resolved = await resolver.resolve(target);
    expect(resolved).toBe(target);
  });

  it("throws BinaryNotFoundError listing the searched candidates when nothing matches", async () => {
    const resolver = new PathBinaryResolver({ PATH: "/nonexistent-dir" }, []);
    await expect(resolver.resolve("definitely-not-a-real-binary-xyz")).rejects.toBeInstanceOf(
      BinaryNotFoundError,
    );
  });

  it("does not match non-executable files", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "concord-bin-"));
    const target = path.join(dir, "not-executable");
    writeFileSync(target, "data");
    chmodSync(target, 0o644);
    const resolver = new PathBinaryResolver({ PATH: dir }, []);
    await expect(resolver.resolve("not-executable")).rejects.toBeInstanceOf(BinaryNotFoundError);
  });

  it("deduplicates directories that appear in both PATH and fallback list", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "concord-bin-"));
    const executable = path.join(dir, "dedup-tool");
    writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    chmodSync(executable, 0o755);
    const resolver = new PathBinaryResolver({ PATH: `${dir}:${dir}` }, [dir]);
    const resolved = await resolver.resolve("dedup-tool");
    expect(resolved).toBe(executable);
  });
});

describe("robustSpawnEnv", () => {
  it("merges PATH with the fallback directories", () => {
    const env = robustSpawnEnv({ PATH: "/custom/bin" });
    expect(typeof env.PATH).toBe("string");
    expect((env.PATH as string).startsWith("/custom/bin")).toBe(true);
    expect(env.PATH).toContain("/usr/bin");
    expect(env.PATH).toContain("/usr/local/bin");
  });

  it("preserves the rest of the supplied environment", () => {
    const env = robustSpawnEnv({ PATH: "/custom/bin", HOME: "/tmp/home" });
    expect(env.HOME).toBe("/tmp/home");
  });

  it("deduplicates entries", () => {
    const env = robustSpawnEnv({ PATH: `/usr/bin:/usr/local/bin` });
    const entries = (env.PATH as string).split(":");
    const unique = new Set(entries);
    expect(entries.length).toBe(unique.size);
  });
});
