import { ArgvParseError, parseArgv } from "../args/argv-parser";
import { builtinCommandHandlers, runCommand, type CommandHandlers } from "./run-command";

export type { CommandHandler, CommandHandlers } from "./run-command";

/** Parses `argv`, dispatches it against the built-in command handlers
 * merged with any extra handlers a deployment contributes, and returns the
 * process exit code. */
export async function runCli(argv: string[], extraHandlers: CommandHandlers = {}): Promise<number> {
  try {
    const parsed = parseArgv(argv);
    return await runCommand(parsed, { ...builtinCommandHandlers(), ...extraHandlers });
  } catch (cause) {
    if (cause instanceof ArgvParseError) {
      process.stderr.write(`concord: ${cause.message}\n`);
      return 2;
    }
    process.stderr.write(
      `concord: ${cause instanceof Error ? cause.message : String(cause)}\n`,
    );
    return 1;
  }
}
