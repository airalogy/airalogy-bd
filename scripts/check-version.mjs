import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function checkVersion(root) {
  const { version } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  if (typeof version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error("软件版本必须使用 x.y.z，不带前缀、后缀或前导零。");
  }
  const changelog = readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
  const entries = [...changelog.matchAll(/^## \[([^\]]+)\] - (\d{4}-\d{2}-\d{2})\s*$/gm)];
  if (entries[0]?.[1] !== version) throw new Error(`更新记录顶部版本必须与 package.json 的 ${version} 一致。`);
  if (entries.filter(entry => entry[1] === version).length !== 1) throw new Error(`更新记录中 ${version} 只能出现一次。`);
  const entry = entries[0], date = new Date(`${entry[2]}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== entry[2]) throw new Error("版本日期必须是真实的 YYYY-MM-DD 日期。");
  const body = changelog.slice(entry.index + entry[0].length).split(/^## /m)[0].trim();
  if (!body) throw new Error(`请补充 ${version} 的更新内容。`);
  return version;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const version = checkVersion(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
    console.log(`版本与更新记录一致：${version}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
