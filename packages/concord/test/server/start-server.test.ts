import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startServer, defaultUiDir, resolveServerConfig, type App, type Composition, type CompositionContributions } from "../../src/server/start-server";

const tempDirs: string[] = [];

function tempDatabasePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "concord-start-server-"));
  tempDirs.push(dir);
  return join(dir, "concord.db");
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

class FakeComposition implements Composition {
  public configureCalls = 0;
  public registerCalls: App[] = [];
  private readonly contributions: CompositionContributions;

  public constructor(contributions: CompositionContributions = {}) {
    this.contributions = contributions;
  }

  public configure(): CompositionContributions {
    this.configureCalls += 1;
    return this.contributions;
  }

  public async register(app: App): Promise<void> {
    this.registerCalls.push(app);
  }
}

describe("startServer", () => {
  it("runs the composition's configure and register steps, starts and stops cleanly", async () => {
    const composition = new FakeComposition();
    const handle = await startServer(
      { host: "127.0.0.1", port: 0, databasePath: tempDatabasePath() },
      composition,
      { installSignalHandlers: false },
    );

    expect(composition.configureCalls).toBe(1);
    expect(composition.registerCalls).toHaveLength(1);
    expect(composition.registerCalls[0]).toBe(handle.app);

    await handle.stop();
  });

  it("starts with no composition (the default entry's shape)", async () => {
    const handle = await startServer(
      { host: "127.0.0.1", port: 0, databasePath: tempDatabasePath() },
      undefined,
      { installSignalHandlers: false },
    );

    expect(handle.app.eventTemplateRegistry.all().map((t) => t.id)).toEqual(["raw-json"]);

    await handle.stop();
  });

  it("resolves the default UI directory to the prebuilt bundle shipped in the package", () => {
    const uiDist = resolve(__dirname, "..", "..", "..", "ui", "dist");
    if (!existsSync(uiDist)) {
      throw new Error(
        "packages/ui/dist not built; run the UI build before this test so the embedded bundle exists",
      );
    }
    const uiDir = defaultUiDir();
    expect(uiDir).toBeDefined();
    expect(existsSync(uiDir as string)).toBe(true);
    expect(existsSync(join(uiDir as string, "index.html"))).toBe(true);
  });
});

describe("resolveServerConfig", () => {
  it("falls back to the documented defaults when no variables are set", () => {
    const config = resolveServerConfig({});
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(3000);
    expect(config.databasePath).toBe(".concord/concord.db");
    expect(config.uiDir).toBeUndefined();
  });

  it("reads the documented variables", () => {
    const config = resolveServerConfig({
      CONCORD_API_HOST: "0.0.0.0",
      CONCORD_API_PORT: "5985",
      CONCORD_DATABASE_PATH: "/data/concord.db",
      CONCORD_UI_DIR: "/srv/ui",
    });
    expect(config.host).toBe("0.0.0.0");
    expect(config.port).toBe(5985);
    expect(config.databasePath).toBe("/data/concord.db");
    expect(config.uiDir).toBe("/srv/ui");
  });
});
