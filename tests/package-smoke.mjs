import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { checkPublication } from "../scripts/check-publication.mjs";

// Exercise the actual package and its independently installed dependencies.
// This is separate from offline unit tests because it downloads from npm.
const root = fileURLToPath(new URL("..", import.meta.url));
const product = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const temp = mkdtempSync(path.join(tmpdir(), "airalogy-bd-package-"));
const outputIndex = process.argv.indexOf("--output-dir");
if (outputIndex >= 0 && !process.argv[outputIndex + 1]) throw new Error("--output-dir requires a path");
const output = outputIndex < 0 ? path.join(temp, "artifacts") : path.resolve(process.argv[outputIndex + 1]);
const env = { ...process.env, BD_MODE: "local", BD_CACHE_DIR: path.join(temp, "python-cache"), NEXT_TELEMETRY_DISABLED: "1", pnpm_config_verify_deps_before_run: "false" };
for (const key of ["BD_RUNTIME_DIRECTORY", "BD_CONTENT_DIR", "BD_DATA_FILE", "BD_SERVICE_FILE", "BD_BRAND_LOGO_FILE", "BD_BRAND_NAME"]) delete env[key];
let child;
async function run(command, args, cwd) {
  const task = spawn(command, args, { cwd, env, stdio: "inherit" });
  const [code] = await once(task, "exit");
  assert.equal(code, 0, `${command} ${args.join(" ")} failed`);
}
async function waitFor(check, timeout = 120000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (child && child.exitCode !== null) throw new Error(`Installed server exited: ${child.exitCode}`);
    const result = await check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error("Installed package did not become ready");
}
async function stop() {
  if (!child) return;
  const server = child; child = undefined;
  const done = once(server, "exit").catch(() => {});
  server.kill("SIGTERM");
  let timer;
  await Promise.race([done, new Promise(resolve => { timer = setTimeout(resolve, 10000); })]);
  clearTimeout(timer);
  // Only this test's detached process group, including its file watcher.
  try { process.kill(-server.pid, "SIGKILL"); } catch { /* already stopped */ }
}
try {
  assert.equal(product.name, "@airalogy/airalogy-bd");
  assert.notEqual(product.private, true);
  assert.equal(product.publishConfig.access, "public");
  mkdirSync(output, { recursive: true });
  const packed = spawnSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", output, "--cache", path.join(temp, "npm-cache")], { cwd: root, encoding: "utf8" });
  assert.equal(packed.status, 0, packed.stderr);
  const report = JSON.parse(packed.stdout);
  const info = Array.isArray(report) ? report[0] : report[product.name];
  const archive = path.join(output, info.filename);
  const extracted = path.join(temp, "extracted"); mkdirSync(extracted);
  await run("tar", ["-xzf", archive, "-C", extracted], temp);
  const packageRoot = path.join(extracted, "package");
  checkPublication(packageRoot, true);
  for (const required of ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md", "dashboard/public/airalogy-logo.svg", "scripts/workspace_service.py.lock"]) assert.ok(existsSync(path.join(packageRoot, required)), required);

  const workspace = path.join(temp, "workspace with spaces"); mkdirSync(workspace);
  await run(process.execPath, [path.join(packageRoot, "bin/bd.mjs"), "init", "--id", "package-demo", "--name", "安装包测试公司"], workspace);
  const manifestPath = path.join(workspace, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.devDependencies[product.name], product.version);
  assert.equal(manifest.private, true);
  // Install the exact unpublished artifact instead of requiring a registry release.
  manifest.devDependencies[product.name] = "file:" + archive;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  await run("pnpm", ["install", "--no-frozen-lockfile", "--registry=https://registry.npmjs.org"], workspace);
  const installed = path.join(workspace, "node_modules/@airalogy/airalogy-bd");
  assert.ok(!realpathSync(installed).startsWith(root), "The smoke test must not link to the source checkout");
  assert.equal(JSON.parse(readFileSync(path.join(installed, "package.json"), "utf8")).version, product.version);
  const cli = path.join(installed, "bin/bd.mjs");
  await run("pnpm", ["exec", "bd", "validate"], workspace);

  // The double-click entry point uses this installed CLI launcher.
  // Stub the OS browser opener so the test never opens a user browser.
  const commands = path.join(temp, "commands"); mkdirSync(commands);
  const opened = path.join(temp, "opened-url.txt");
  writeFileSync(path.join(commands, "open"), "#!/usr/bin/env node\nrequire('node:fs').writeFileSync(process.env.BD_SMOKE_OPEN_FILE, process.argv[2]);\n");
  chmodSync(path.join(commands, "open"), 0o755);
  child = spawn(process.execPath, [cli, "launch"], { cwd: workspace, env: { ...env, PATH: commands + path.delimiter + env.PATH, BD_SMOKE_OPEN_FILE: opened }, stdio: "inherit", detached: true });
  const url = await waitFor(() => existsSync(opened) && readFileSync(opened, "utf8"));
  assert.match(url, /^http:\/\/127\.0\.0\.1:30\d\d$/);
  const response = await fetch(url + "/api/workspace?action=workspace");
  const data = await response.json();
  assert.equal(data.ok, true);
  assert.equal(data.result.data.workspace.id, "package-demo");
  assert.deepEqual(data.result.status.errors, []);
  assert.equal(await (await fetch(url + "/airalogy-logo.svg")).text(), readFileSync(path.join(packageRoot, "dashboard/public/airalogy-logo.svg"), "utf8"));
  await stop();

  // Re-initializing an installed workspace must preserve existing business files.
  cpSync(path.join(root, "fixtures/demo/content"), path.join(workspace, "content"), { recursive: true });
  const people = readFileSync(path.join(workspace, "content/people.yaml"));
  await run("pnpm", ["exec", "bd", "init"], workspace);
  assert.deepEqual(readFileSync(path.join(workspace, "content/people.yaml")), people);
  assert.equal(JSON.parse(readFileSync(manifestPath, "utf8")).devDependencies[product.name], "file:" + archive);
  await run("pnpm", ["exec", "bd", "validate"], workspace);
  await run("pnpm", ["exec", "bd", "build"], workspace);
  const build = JSON.parse(readFileSync(path.join(workspace, ".airalogy-bd/dashboard/app/lib/build-info.json"), "utf8"));
  assert.equal(build.version, product.version);
  assert.equal(build.channel, "installed");
  const sha256 = createHash("sha256").update(readFileSync(archive)).digest("hex");
  writeFileSync(archive + ".sha256", `${sha256}  ${info.filename}\n`);
  console.log(`Package installation, launcher, logo, existing content and production build passed: ${info.filename}`);
  if (outputIndex >= 0) console.log(`Verified artifact: ${archive}`);
} finally {
  await stop();
  rmSync(temp, { recursive: true, force: true });
}
