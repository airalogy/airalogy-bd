import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initializeWorkspace } from "../bin/init.mjs";

// Exercise the real CLI and Next.js watcher without Docker, browser downloads,
// or edits to the developer's checkout and business workspace.
const root = fileURLToPath(new URL("..", import.meta.url));
const temp = mkdtempSync(path.join(tmpdir(), "bd-dev-smoke-"));
const source = path.join(temp, "source"), workspace = path.join(temp, "workspace");
const ignored = new Set(["node_modules", ".next", "__pycache__", "next-env.d.ts", "tsconfig.tsbuildinfo"]);
const sourceFile = relative => path.join(source, "dashboard", relative);
const put = (relative, value) => { const target = sourceFile(relative); mkdirSync(path.dirname(target), {recursive:true}); writeFileSync(target, value); };
const page = text => `"use client";\nimport "./probe.css";\nexport default function Probe() { return <p className="dev-probe">${text}</p>; }\n`;
const route = text => `export function GET() { return Response.json({value:${JSON.stringify(text)}}); }\n`;
let child, socket, ping, output = "", base;
const messages = [];
const env = {...process.env, BD_MODE:"local", BD_CACHE_DIR:process.env.BD_CACHE_DIR || path.join(root, ".uv-cache"), NEXT_TELEMETRY_DISABLED:"1", pnpm_config_verify_deps_before_run:"false"};
for (const key of ["BD_RUNTIME_DIRECTORY", "BD_CONTENT_DIR", "BD_DATA_FILE", "BD_SERVICE_FILE", "NEXT_PUBLIC_BD_DEV_BUILD_INFO"]) delete env[key];

async function waitFor(check, description, timeout = 90000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error(`Development server exited: ${child.exitCode}\n${output}`);
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out: ${description}\nHMR: ${JSON.stringify(messages.slice(-5))}\n${output}`);
}
async function start() {
  const reservation = createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [path.join(source, "bin/bd.mjs"), "dev", "--source", "--port", String(port)], {cwd:workspace, env, stdio:["ignore", "pipe", "pipe"], detached:process.platform !== "win32"});
  for (const stream of [child.stdout, child.stderr]) stream.on("data", data => { output += data; });
  await waitFor(async () => {
    try { return (await fetch(base + "/dev-probe", {signal:AbortSignal.timeout(10000)})).status === 200; }
    catch { return false; }
  }, "development server ready");
}
async function stop() {
  clearInterval(ping); socket?.close(); socket = undefined;
  if (!child) return;
  const server = child; child = undefined;
  const done = once(server, "close"); server.kill("SIGTERM");
  let timer;
  try { await Promise.race([done, new Promise(resolve => { timer = setTimeout(resolve, 10000); })]); }
  finally {
    clearTimeout(timer);
    if (process.platform !== "win32") { try { process.kill(-server.pid, "SIGKILL"); } catch { /* already stopped */ } }
    else if (server.exitCode === null) server.kill("SIGKILL");
  }
}
async function connectHmr() {
  socket = new WebSocket(base.replace("http:", "ws:") + "/_next/hmr");
  socket.addEventListener("message", event => {
    if (typeof event.data !== "string") return;
    try { messages.push(JSON.parse(event.data)); } catch { /* binary devtools payload */ }
  });
  socket.addEventListener("error", () => {});
  await waitFor(() => socket.readyState === WebSocket.OPEN && messages.some(message => message.type === "sync"), "Next.js HMR connection");
  ping = setInterval(() => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({event:"ping", page:"/dev-probe", appDirRoute:true}));
  }, 1000);
}
async function expectHotUpdate(change) {
  const offset = messages.length;
  change();
  await waitFor(() => messages.slice(offset).some(message => message.type === "built" && message.errors?.length === 0), "native hot update notification");
}
async function status(relative, expected) {
  await waitFor(async () => (await fetch(base + relative)).status === expected, `${relative}: ${expected}`);
}

try {
  mkdirSync(source); mkdirSync(workspace);
  for (const name of ["bin", "dashboard", "scripts", "templates", "package.json", "pnpm-lock.yaml"]) {
    cpSync(path.join(root, name), path.join(source, name), {recursive:true, filter:filename => !ignored.has(path.basename(filename))});
  }
  symlinkSync(realpathSync(path.join(root, "node_modules")), path.join(source, "node_modules"), "dir");
  initializeWorkspace(workspace, source, {id:"dev-smoke", name:"开发测试公司"});
  const identity = readFileSync(sourceFile("app/lib/build-info.json"), "utf8");
  put("app/dev-probe/page.tsx", page("before-fast-refresh"));
  put("app/dev-probe/probe.css", ".dev-probe { color: rgb(1, 2, 3); }\n");
  put("app/api/dev-probe/route.ts", route("before-api-edit"));
  await start();
  assert.match(output, /源码开发模式/);
  assert.ok(!existsSync(path.join(workspace, ".airalogy-bd/dashboard")), "source development must not prepare a copy");
  assert.match(await (await fetch(base + "/dev-probe")).text(), /before-fast-refresh/);
  assert.deepEqual(await (await fetch(base + "/api/dev-probe")).json(), {value:"before-api-edit"});
  await connectHmr();
  console.log("Native Next.js HMR connected.");

  // Atomic editor saves must be observed by Next.js without restarting the CLI.
  await expectHotUpdate(() => {
    put("app/dev-probe/page.tsx.tmp", page("after-fast-refresh"));
    renameSync(sourceFile("app/dev-probe/page.tsx.tmp"), sourceFile("app/dev-probe/page.tsx"));
  });
  assert.match(await (await fetch(base + "/dev-probe")).text(), /after-fast-refresh/);
  await expectHotUpdate(() => put("app/dev-probe/probe.css", ".dev-probe { color: rgb(4, 5, 6); }\n"));
  const html = await (await fetch(base + "/dev-probe")).text();
  const styles = [...html.matchAll(/href="([^"]+\.css(?:\?[^"]*)?)"/g)].map(match => match[1].replaceAll("&amp;", "&"));
  assert.ok(styles.length);
  const css = await Promise.all(styles.map(async href => (await fetch(new URL(href, base))).text()));
  assert.match(css.join("\n"), /rgb\(4, 5, 6\)/);
  put("app/api/dev-probe/route.ts", route("after-api-edit"));
  await waitFor(async () => (await (await fetch(base + "/api/dev-probe")).json()).value === "after-api-edit", "API source edit");
  put("app/api/dev-added/route.ts", route("new-route"));
  await status("/api/dev-added", 200);
  renameSync(sourceFile("app/api/dev-added"), sourceFile("app/api/dev-renamed"));
  await status("/api/dev-renamed", 200); await status("/api/dev-added", 404);
  rmSync(sourceFile("app/api/dev-renamed"), {recursive:true});
  await status("/api/dev-renamed", 404);
  assert.equal(readFileSync(sourceFile("app/lib/build-info.json"), "utf8"), identity, "public source identity remains a placeholder");
  assert.ok(!existsSync(sourceFile("AGENTS.md")), "development must not add generated instruction files to the source");
  const home = await (await fetch(base)).text();
  const version = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
  assert.ok(home.includes(`v${version}`), "source dev exposes the actual package version");
  await stop();
  const cache = sourceFile(".next/dev/cache");
  assert.ok(existsSync(cache), "Next.js must produce its own development cache");
  const sentinel = path.join(cache, "bd-smoke-sentinel"); writeFileSync(sentinel, "keep cached compilation");
  await start();
  assert.equal(readFileSync(sentinel, "utf8"), "keep cached compilation", "CLI restart must not clear the framework cache");
  assert.match(await (await fetch(base + "/dev-probe")).text(), /after-fast-refresh/);
  console.log("Source development passed: native HMR notifications, component and CSS edits, API edits/add/rename/delete, unchanged source identity, isolated workspace, cache retained on restart.");
} finally {
  await stop();
  rmSync(temp, {recursive:true, force:true});
}
