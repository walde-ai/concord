#!/usr/bin/env node
import { runCli } from "../main/run-cli";

runCli(process.argv.slice(2))
  .then((exitCode) => {
    process.exit(exitCode);
  })
  .catch((cause) => {
    process.stderr.write(
      `concord: unexpected error: ${cause instanceof Error ? cause.message : String(cause)}\n`,
    );
    process.exit(1);
  });
