import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// A conservative source/artifact gate, not a substitute for reviewing business content
// or running a dedicated secret scanner. Findings never print matched values.
export function inspectPublicationFile(relative, data, { symlink = false } = {}) {
  const findings = [];
  const parts = relative.split("/");
  const name = parts.at(-1);
  if (symlink) findings.push("symbolic link requires review");
  if (parts.some(part => /^\.(?:git|airalogy-bd|bd-.+|pnpm-store|uv-cache|next)$/.test(part) || ["node_modules", "__pycache__", "backups", "attachments"].includes(part)) ||
      (parts.includes("content") && !relative.startsWith("fixtures/demo/content/")) ||
      parts.includes("generated") ||
      (/^\.env(?:\.|$)/.test(name) && relative !== "deploy/.env.example") ||
      /\.(?:db(?:-.*)?|sqlite\w*(?:-.*)?|pem|key|p12|pfx|zip|tar|tgz|gz|log|docx?|xlsx?|pptx?|pdf)$/i.test(name)) {
    findings.push("private data, credential or runtime artifact path");
  }
  if (data.includes(0)) findings.push("binary file requires review");
  const text = data.toString("utf8");
  if (/(?:\/Users\/|\/home\/)[\w.-]+\//.test(text)) findings.push("personal home directory");
  if (/-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/.test(text)) findings.push("private key");
  // Remove URL userinfo test cases before inspecting literal email addresses.
  const emails = text.replace(/https?:\/\/[^\s"'<>`]+/g, "").match(/[\w.+%-]+@(?:[\w-]+\.)+[A-Za-z]{2,}/g) || [];
  if (emails.some(email => !/(?:@|\.)(?:example\.(?:com|net|org)|invalid|example|test)$|@users\.noreply\.github\.com$/i.test(email))) {
    findings.push("non-example email address requires review");
  }
  if (relative === "dashboard/app/lib/build-info.json") {
    try {
      const info = JSON.parse(text);
      if (Object.entries(info).some(([key, value]) => value !== (key === "channel" ? "unknown" : ""))) findings.push("generated build identity in source");
    } catch { findings.push("invalid build identity placeholder"); }
  }
  return findings;
}

function directoryFiles(root, relative = "") {
  return readdirSync(path.join(root, relative)).flatMap(name => {
    if (!relative && name === ".git") return [];
    const file = relative ? `${relative}/${name}` : name;
    return lstatSync(path.join(root, file)).isDirectory() ? directoryFiles(root, file) : [file];
  });
}

export function checkPublication(root, directory = false) {
  // Include untracked, non-ignored source; never rely on ignores to hide tracked files.
  const files = directory ? directoryFiles(root) : execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  const findings = [];
  let checked = 0;
  for (const file of new Set(files)) {
    const absolute = path.join(root, file), stat = lstatSync(absolute, { throwIfNoEntry: false });
    // Git's tracked list includes deleted/renamed sources until they are staged.
    if (!stat) continue;
    checked += 1;
    const issues = inspectPublicationFile(file, stat.isSymbolicLink() ? Buffer.alloc(0) : readFileSync(absolute), { symlink: stat.isSymbolicLink() });
    findings.push(...issues.map(issue => `${file}: ${issue}`));
  }
  if (findings.length) throw new Error(findings.join("\n"));
  return checked;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const directory = process.argv[2] === "--directory";
    if (process.argv.length > 2 && (!directory || process.argv.length !== 4)) throw new Error("Usage: check-publication.mjs [--directory extracted-source]");
    const root = directory ? path.resolve(process.argv[3]) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    console.log(`公开文件基础检查通过：${checkPublication(root, directory)} 个文件。仍须人工复核业务信息并运行密钥扫描。`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
