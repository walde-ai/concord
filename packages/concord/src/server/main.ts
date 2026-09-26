#!/usr/bin/env node
import { resolveServerConfig, startServer } from "./start-server";

async function run(): Promise<void> {
  const config = resolveServerConfig(process.env);
  await startServer(config, undefined, { installSignalHandlers: true });
}

run().catch((cause) => {
  console.error("[concord-server] fatal error:", cause);
  process.exit(1);
});
