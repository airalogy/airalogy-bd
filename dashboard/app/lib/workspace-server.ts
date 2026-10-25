import "server-only";
import { spawn } from "node:child_process";
import { verifiedSessionToken } from "./auth-provider";

export function isLocalRequest(request: Request) {
  const url = new URL(request.url);
  const hostname = url.hostname;
  const local = ["localhost", "127.0.0.1", "[::1]"];
  const host = request.headers.get("host");
  try {return local.includes(hostname) && (!host || local.includes(new URL(`http://${host}`).hostname));} catch {return false;}
}

export async function invokeWorkspace(input: Record<string, unknown>, session = ""): Promise<Record<string, unknown>> {
  const script = process.env.BD_SERVICE_FILE;
  const content = process.env.BD_CONTENT_DIR;
  const cache = process.env.BD_CACHE_DIR;
  if (!script || !content || !cache) {
    return Promise.resolve({ok: false, code: "unavailable", error: "资料服务尚未配置，请检查工作台启动配置后重试。"});
  }
  const verifiedToken = process.env.BD_MODE === "server" ? await verifiedSessionToken(session) : "";
  return runWorkspace(input, verifiedToken);
}

// A dedicated transport: external tokens are never accepted as browser sessions.
export function invokeRemote(input: { tool: string; arguments: Record<string, unknown> }, token: string) {
  return runWorkspace({ ...input, action: "remote_rpc" }, "", token);
}

function runWorkspace(input: Record<string, unknown>, verifiedToken: string, remoteToken = ""): Promise<Record<string, unknown>> {
  const script = process.env.BD_SERVICE_FILE;
  const content = process.env.BD_CONTENT_DIR;
  const cache = process.env.BD_CACHE_DIR;
  if (!script || !content || !cache) return Promise.resolve({ ok: false, code: "unavailable", error: "资料服务尚未配置。" });
  return new Promise((resolve) => {
    const child = spawn("uv", ["run", "--cache-dir", cache, "--locked", script, "--content-dir", content], {stdio: ["pipe", "pipe", "pipe"], env: {...process.env, BD_REQUEST_WEB: "1", BD_SESSION: verifiedToken, BD_REMOTE_TOKEN: remoteToken}});
    let output = "";
    let failed = false;
    const timer = setTimeout(() => { failed = true; child.kill(); }, input.action === "backup_now" || input.action === "file_backup" ? 300000 : 60000);
    // Decode across pipe chunks so a split UTF-8 character stays intact.
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { output += chunk; if (output.length > 12_000_000) { failed = true; child.kill(); } });
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.on("error", () => { clearTimeout(timer); resolve({ok: false, code: "unavailable", error: "无法启动资料服务，请检查工作台环境。"}); });
    child.on("close", () => {
      clearTimeout(timer);
      try {
        if (failed) throw new Error();
        resolve(JSON.parse(output));
      } catch {
        resolve({ok: false, code: "service", error: "资料服务暂时没有响应，当前资料和已留存版本仍然保留。"});
      }
    });
    child.stdin.end(JSON.stringify(input));
  });
}
