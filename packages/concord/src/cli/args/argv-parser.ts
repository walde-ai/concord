export interface ParsedArgs {
  readonly noun: string;
  readonly verb: string;
  readonly flags: Record<string, string>;
  readonly positionals: string[];
}

export class ArgvParseError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ArgvParseError";
  }
}

export function parseArgv(args: string[]): ParsedArgs {
  if (args.length < 2) {
    throw new ArgvParseError("usage: concord <noun> <verb> [--flag value | --flag=value]...");
  }
  const noun = args[0];
  const verb = args[1];
  if (noun.startsWith("-") || verb.startsWith("-")) {
    throw new ArgvParseError(`noun and verb must not start with '--', got: ${noun} ${verb}`);
  }
  const flags: Record<string, string> = {};
  const positionals: string[] = [];

  let i = 2;
  while (i < args.length) {
    const token = args[i];
    if (token.startsWith("--")) {
      const inlineEqual = token.indexOf("=");
      if (inlineEqual >= 0) {
        const name = token.slice(2, inlineEqual);
        const value = token.slice(inlineEqual + 1);
        if (name.length === 0) {
          throw new ArgvParseError(`invalid flag syntax: ${token}`);
        }
        flags[name] = value;
        i += 1;
      } else {
        const name = token.slice(2);
        if (name.length === 0) {
          throw new ArgvParseError("invalid flag syntax: --");
        }
        if (i + 1 >= args.length) {
          throw new ArgvParseError(`flag --${name} requires a value`);
        }
        flags[name] = args[i + 1];
        i += 2;
      }
    } else {
      positionals.push(token);
      i += 1;
    }
  }

  return { noun, verb, flags, positionals };
}
