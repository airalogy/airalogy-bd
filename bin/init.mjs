import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export function initializeWorkspace(directory, packageRoot, {id = "local-company", name = "本地公司", source = false} = {}) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error("工作区 ID 须使用小写字母、数字和连字符。");
  const product = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  if (!/^\d+\.\d+\.\d+$/.test(product.version)) throw new Error("程序版本无效，无法初始化工作区依赖。");
  const manifestPath = path.join(directory, "package.json");
  if (lstatSync(manifestPath, {throwIfNoEntry: false})?.isSymbolicLink()) throw new Error("工作区 package.json 不能使用符号链接。");
  const existing = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : {};
  if (!existing || typeof existing !== "object" || Array.isArray(existing)) throw new Error("工作区 package.json 格式无效。");
  if (existing.name === product.name) throw new Error("请在独立的业务目录初始化工作区，不要在程序包目录执行。");
  const dependency = source ? "link:" + path.relative(directory, packageRoot) : product.version;
  const manifest = {
    name: id + "-bd", packageManager: product.packageManager, engines: product.engines,
    ...existing, private: true,
    scripts: {dev: "bd dev", validate: "bd validate", data: "bd data", build: "bd build", start: "bd start", checkpoint: "bd checkpoint", launch: "bd launch", ...existing.scripts},
    ...(!existing.dependencies?.[product.name] && !existing.devDependencies?.[product.name]
      ? {devDependencies: {...existing.devDependencies, [product.name]: dependency}} : {}),
  };
  const write = (relative, text) => {
    const target = path.join(directory, relative);
    if (existsSync(target)) return;
    mkdirSync(path.dirname(target), {recursive: true});
    writeFileSync(target, text, {flag: "wx"});
  };
  for (const relative of ["content/counterparties", "content/company/records"]) mkdirSync(path.join(directory, relative), {recursive: true});
  write("content/workspace.yaml", JSON.stringify({id, name, short_name: name, workspace_title: name + " BD 工作台", description: name + "的业务对接工作区", locale: "zh-CN", timezone: "Asia/Shanghai", brand_mark: "BD", privacy_notice: process.env.BD_MODE === "server" ? "公司内部资料，仅限获授权成员" : "仅在本地使用"}, null, 2) + "\n");
  write("content/people.yaml", "people: []\n");
  write("content/company/events.yaml", `company: ${id}\nevents: []\n`);
  write("content/files.yaml", "schema_version: 1\nfiles: []\n");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  write("pnpm-workspace.yaml", "packages:\n  - .\nengineStrict: true\nallowBuilds:\n  sharp: true\n  unrs-resolver: true\n");
  write(".gitignore", "node_modules/\n.pnpm-store/\n.uv-cache/\n.airalogy-bd/\n.bd-history/\n.bd-auth/\n.bd-ai/\n.env\n.env.*\n!.env.example\ncontent/generated/\ncontent/counterparties/*/attachments/\n.DS_Store\n");
  const launcher = "启动 Airalogy BD.command";
  write(launcher, `#!/bin/bash
cd -- "$(dirname -- "$0")" || exit 1
export PATH="$HOME/.local/share/pnpm:$HOME/.local/bin:$HOME/.volta/bin:$HOME/.nvm/current/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  echo "未找到 Node.js，请安装 Node.js 22.13 或更高版本，再重新双击。"
  read -r -p "按回车关闭窗口……"
  exit 1
fi
if [ ! -f "node_modules/@airalogy/airalogy-bd/bin/bd.mjs" ]; then
  echo "尚未安装工作区依赖。请在此目录运行 pnpm install 后重新双击。"
  read -r -p "按回车关闭窗口……"
  exit 1
fi
node "node_modules/@airalogy/airalogy-bd/bin/bd.mjs" launch
status=$?
if [ "$status" -ne 0 ]; then
  echo "启动失败，请根据上方提示处理后重试。"
  read -r -p "按回车关闭窗口……"
fi
exit "$status"
`);
  chmodSync(path.join(directory, launcher), 0o755);
}
