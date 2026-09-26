// Copies the built dashboard bundle from the sibling UI workspace into
// this package's `ui/` folder so the server serves it by default and npm
// ships it inside the tarball. Build order at the root is UI first, then
// this package.
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const uiDist = resolve(packageRoot, "..", "ui", "dist");
const target = join(packageRoot, "ui");

if (!existsSync(uiDist)) {
  console.warn("[concord] no UI bundle found at packages/ui/dist; skipping embed (dashboard will not be served by default)");
  process.exit(0);
}

rmSync(target, { recursive: true, force: true });
cpSync(uiDist, target, { recursive: true });
console.log(`[concord] embedded UI bundle: ${target}`);
