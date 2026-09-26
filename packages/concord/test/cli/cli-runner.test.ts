import { describe, it, expect } from "vitest";
import { runCli } from "../../src/cli/main/run-cli";

describe("runCli", () => {
  it("dispatches an extra noun/verb handler merged over the built-ins", async () => {
    const calls: string[] = [];
    const exitCode = await runCli(["greet", "go", "--name", "world"], {
      "greet go": async (parsed) => {
        calls.push(parsed.flags.name);
        return 42;
      },
    });

    expect(calls).toEqual(["world"]);
    expect(exitCode).toBe(42);
  });

  it("extra handlers do not shadow built-in absence for other commands", async () => {
    const exitCode = await runCli(["nope", "nope"], {
      "greet go": async () => 0,
    });

    expect(exitCode).toBe(2);
  });

  it("reports usage errors with exit code 2", async () => {
    const exitCode = await runCli(["only-one-token"]);
    expect(exitCode).toBe(2);
  });

  it("rejects unknown built-in commands with exit code 2", async () => {
    const exitCode = await runCli(["user", "explode"]);
    expect(exitCode).toBe(2);
  });
});
