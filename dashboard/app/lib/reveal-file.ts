import "server-only";
import { execFile } from "node:child_process";
import path from "node:path";

// The caller must resolve this path from the file library, never from user input.
export async function revealFile(filename: string): Promise<Record<string, unknown>> {
  let command: string;
  let args: string[];
  if (process.platform === "darwin") {
    command = "open"; args = ["-R", filename];
  } else if (process.platform === "win32") {
    command = "explorer.exe"; args = [`/select,${filename}`];
  } else if (process.platform === "linux") {
    command = "xdg-open"; args = [path.dirname(filename)];
  } else {
    return { ok: false, code: "unavailable", error: "当前系统暂不支持打开所在文件夹，请下载文件查看。" };
  }
  return new Promise(resolve => {
    execFile(command, args, { timeout: 10_000 }, error => {
      resolve(error
        ? { ok: false, code: "unavailable", error: "未能打开所在文件夹，请确认工作台正在有桌面环境的本机运行，或下载文件查看。" }
        : { ok: true, result: { message: "已打开文件所在文件夹。" } });
    });
  });
}
