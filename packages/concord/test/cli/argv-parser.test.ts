import { describe, it, expect } from "vitest";
import { parseArgv, ArgvParseError } from "../../src/cli/args/argv-parser";

describe("argv parser", () => {
  it("parses noun, verb, and space-separated flags", () => {
    const parsed = parseArgv(["user", "create", "--name", "alice", "--password", "pw"]);

    expect(parsed.noun).toBe("user");
    expect(parsed.verb).toBe("create");
    expect(parsed.flags.name).toBe("alice");
    expect(parsed.flags.password).toBe("pw");
  });

  it("parses --flag=value syntax", () => {
    const parsed = parseArgv(["event", "emit", "--type=foo", "--payload", "{}"]);

    expect(parsed.flags.type).toBe("foo");
    expect(parsed.flags.payload).toBe("{}");
  });

  it("collects positionals that do not start with --", () => {
    const parsed = parseArgv(["event", "emit", "extra"]);

    expect(parsed.positionals).toEqual(["extra"]);
  });

  it("throws when a flag is missing its value", () => {
    expect(() => parseArgv(["user", "create", "--name"])).toThrow(ArgvParseError);
  });

  it("throws when noun or verb is missing", () => {
    expect(() => parseArgv(["user"])).toThrow(ArgvParseError);
  });

  it("throws on an empty --", () => {
    expect(() => parseArgv(["user", "create", "--=x"])).toThrow(ArgvParseError);
  });
});
