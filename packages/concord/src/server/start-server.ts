import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { RunCompletionHook } from "../domain/ports/out/run-completion-hook";
import { MakeApp, type AppConfig } from "../infra/main/make-app";
import type { App } from "../infra/main/app";

export interface ServerConfig {
  readonly host: string;
  readonly port: number;
  readonly databasePath: string;
  /** Directory of static UI assets to serve; when omitted the prebuilt
   * dashboard bundle shipped inside the package is used. */
  readonly uiDir?: string;
}

/** What a deployment composition contributes to the generic app
 * configuration before the app is constructed. */
export interface CompositionContributions {
  readonly runCompletionHooks?: readonly RunCompletionHook[];
}

/** A deployment composition: turns a generic Concord app into a specific
 * installation by contributing configuration (before construction) and
 * registering producers, consumers, event templates and widgets (after
 * construction, before start). */
export interface Composition {
  configure(): CompositionContributions;
  register(app: App): Promise<void>;
}

export interface ServerHandle {
  readonly app: App;
  stop(): Promise<void>;
}

export interface StartServerOptions {
  /** Whether startServer installs the SIGTERM/SIGINT graceful-shutdown
   * handlers (the default server entry does; embeddings and tests opt
   * out to keep control of the process lifecycle). */
  readonly installSignalHandlers: boolean;
}

export function resolveServerConfig(env: NodeJS.ProcessEnv): ServerConfig {
  return {
    host: env.CONCORD_API_HOST ?? "127.0.0.1",
    port: Number(env.CONCORD_API_PORT ?? "3000"),
    databasePath: env.CONCORD_DATABASE_PATH ?? ".concord/concord.db",
    uiDir: resolveUiDir(env.CONCORD_UI_DIR),
  };
}

function resolveUiDir(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0) {
    return undefined;
  }
  return value;
}

/** Directory of the prebuilt dashboard bundle shipped inside the package
 * (<package root>/ui), when present. */
export function defaultUiDir(): string | undefined {
  const candidate = resolve(__dirname, "..", "..", "ui");
  return existsSync(candidate) ? candidate : undefined;
}

export async function startServer(
  config: ServerConfig,
  composition: Composition | undefined,
  options: StartServerOptions,
): Promise<ServerHandle> {
  const contributions = composition?.configure() ?? {};
  const appConfig: AppConfig = {
    databasePath: config.databasePath,
    api: {
      host: config.host,
      port: config.port,
      uiDir: config.uiDir ?? defaultUiDir(),
    },
    runCompletionHooks: contributions.runCompletionHooks,
  };
  const app = MakeApp(appConfig);

  if (composition !== undefined) {
    await composition.register(app);
  }

  await app.start();

  app.logger.info("concord-server", "listening", { url: `http://${config.host}:${config.port}` });

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) {
      return;
    }
    stopped = true;
    await app.stop();
  };

  if (options.installSignalHandlers) {
    installShutdownHandlers(app, stop);
  }

  return { app, stop };
}

function installShutdownHandlers(app: App, stop: () => Promise<void>): void {
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    try {
      app.logger.info("concord-server", "shutting down");
      await stop();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      console.error("[concord-server] error during shutdown:", message);
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}
