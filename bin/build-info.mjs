import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

// Freeze the identity of the software being copied, independent of company data.
export function createBuildInfo(packageRoot) {
  const manifest = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  const hash = createHash("sha256");
  const ignored = new Set(["node_modules", ".next", "__pycache__", ".pytest_cache", ".DS_Store", "tsconfig.tsbuildinfo"]);
  const visit = relative => {
    const absolute = path.join(packageRoot, relative);
    if (!existsSync(absolute)) return;
    for (const item of readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      if (ignored.has(item.name) || item.name.endsWith(".pyc")) continue;
      const name = path.posix.join(relative, item.name);
      if (item.isDirectory()) visit(name);
      else if (item.isFile()) add(name);
    }
  };
  const add = relative => {
    const absolute = path.join(packageRoot, relative);
    if (existsSync(absolute)) hash.update(relative).update("\0").update(readFileSync(absolute)).update("\0");
  };
  for (const directory of ["bin", "dashboard", "scripts"]) visit(directory);
  for (const filename of ["package.json", "pnpm-lock.yaml"]) add(filename);
  const local = existsSync(path.join(packageRoot, ".git"));
  const revision = local ? spawnSync("git", ["-C", packageRoot, "rev-parse", "--short=7", "HEAD"], { encoding: "utf8", timeout: 3000 }).stdout?.trim() || "" : "";
  return {
    version: manifest.version,
    build_id: hash.digest("hex").slice(0, 12),
    built_at: new Date().toISOString(),
    channel: local ? "local" : "installed",
    revision,
  };
}
