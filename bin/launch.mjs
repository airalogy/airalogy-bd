import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
async function ready(url) {
  try {
    const response = await fetch(url + "/api/workspace?action=workspace", {signal: AbortSignal.timeout(1500)});
    if (!response.ok) return false;
    const result = await response.json();
    return result.ok && !result.result.status.errors.length;
  } catch { return false; }
}
async function availablePort() {
  for (let port = 3000; port < 3100; port++) {
    const available = await new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once("error", error => error.code === "EADDRINUSE" ? resolve(false) : reject(error));
      server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
    });
    if (available) return port;
  }
  throw new Error("3000–3099 端口均被占用，请关闭不用的本地服务后重试。");
}
function openBrowserWindow(url) {
  return new Promise((resolve, reject) => {
    const browser = spawn("open", [url], {stdio: "ignore"});
    browser.once("error", reject);
    browser.once("exit", code => code === 0 ? resolve() : reject(new Error("无法打开浏览器，请检查默认浏览器设置。")));
  });
}
export async function launchWorkspace({cli, workspace = process.cwd(), openBrowser = openBrowserWindow, timeoutMs = 120000}) {
  const cache = path.join(workspace, ".airalogy-bd");
  const lock = path.join(cache, "launcher-lock");
  const stateFile = path.join(lock, "state.json");
  mkdirSync(cache, {recursive: true});
  for (;;) {
    try { mkdirSync(lock); break; } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let state;
      // Another launcher may still be writing its ownership record.
      for (let attempt = 0; attempt < 20 && !state; attempt++) {
        try { state = JSON.parse(readFileSync(stateFile, "utf8")); } catch { await delay(100); }
      }
      if (!state || !alive(state.pid)) { rmSync(lock, {recursive: true, force: true}); continue; }
      console.log("工作台正在运行或启动，等待页面准备完成……");
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline && alive(state.pid)) {
        if (state.url && await ready(state.url)) { await openBrowser(state.url); return {reused: true, url: state.url}; }
        try { state = JSON.parse(readFileSync(stateFile, "utf8")); } catch { break; }
        await delay(300);
      }
      throw new Error("已有启动进程尚未就绪，请查看原启动窗口中的错误后重试。");
    }
  }
  let child;
  const stop = signal => child?.kill(signal);
  try {
    writeFileSync(stateFile, JSON.stringify({pid: process.pid}));
    const port = await availablePort();
    const url = `http://127.0.0.1:${port}`;
    writeFileSync(stateFile, JSON.stringify({pid: process.pid, url}));
    child = spawn(process.execPath, [cli, "dev", "--webpack", "--port", String(port)], {cwd: workspace, stdio: "inherit"});
    let finished = false;
    const completion = new Promise((resolve, reject) => {
      child.once("error", error => { finished = true; reject(error); });
      child.once("exit", code => { finished = true; resolve(code); });
    });
    // Keep an early process error handled while readiness is being checked.
    completion.catch(() => {});
    process.on("SIGINT", stop); process.on("SIGTERM", stop);
    const deadline = Date.now() + timeoutMs;
    let opened = false;
    while (!finished && Date.now() < deadline) {
      if (await ready(url)) { await openBrowser(url); opened = true; console.log(`工作台已打开：${url}。关闭此窗口会停止服务。`); break; }
      await delay(300);
    }
    if (!opened && !finished) { child.kill("SIGTERM"); throw new Error("启动超时，请检查上方日志；修复后重新双击启动文件。"); }
    const code = await completion;
    if (code !== 0) throw new Error(`工作台启动或运行失败（退出码 ${code ?? "中断"}），请检查上方日志。`);
    if (!opened) throw new Error("服务在页面就绪前退出，请检查上方日志。");
    return {reused: false, url};
  } finally {
    child?.kill("SIGTERM");
    process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
    if (existsSync(lock)) rmSync(lock, {recursive: true, force: true});
  }
}
