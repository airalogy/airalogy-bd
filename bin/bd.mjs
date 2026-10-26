#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initializeWorkspace } from "./init.mjs";
import { launchWorkspace } from "./launch.mjs";
import { createBuildInfo } from "./build-info.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dashboardSourceDirectory = path.join(packageRoot, "dashboard");
const scriptsDirectory = path.join(packageRoot, "scripts");
const cacheDirectory = process.env.BD_CACHE_DIR || path.join(process.cwd(), ".uv-cache");
const require = createRequire(import.meta.url);
const packageManifest = JSON.parse(
  readFileSync(path.join(packageRoot, "package.json"), "utf8"),
);

function fail(message) {
  console.error(message);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    stdio: "inherit",
  });
  if (result.error) fail(`无法执行 ${command}：${result.error.message}`);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function parseArguments(rawArguments) {
  const remaining = [];
  let content = "content";
  for (let index = 0; index < rawArguments.length; index += 1) {
    const argument = rawArguments[index];
    if (argument === "--") {remaining.push(...rawArguments.slice(index));break;}
    if (argument === "--content") {
      const value = rawArguments[index + 1];
      if (!value) fail("--content 需要提供目录路径");
      content = value;
      index += 1;
    } else if (argument.startsWith("--content=")) {
      content = argument.slice("--content=".length);
    } else {
      remaining.push(argument);
    }
  }
  return {
    contentDirectory: path.resolve(process.cwd(), content),
    remaining,
  };
}

function runPythonScript(scriptName, contentDirectory, extraArguments = []) {
  run("uv", [
    "run",
    "--cache-dir",
    cacheDirectory,
    "--locked",
    path.join(scriptsDirectory, scriptName),
    "--content-dir",
    contentDirectory,
    ...extraArguments,
  ]);
}

function generateData(contentDirectory) {
  const output = path.join(contentDirectory, "generated", "dashboard.json");
  runPythonScript("generate_dashboard_data.py", contentDirectory, ["--output", output]);
  return output;
}

function dependencyDirectory() {
  const resolvedPackageRoot = realpathSync(packageRoot);
  const candidates = [
    path.join(resolvedPackageRoot, "node_modules"),
    path.resolve(resolvedPackageRoot, "../.."),
  ];
  const dependencies = Object.keys(packageManifest.dependencies ?? {});
  const dependencyRoot = candidates.find((candidate) =>
    dependencies.every((dependency) =>
      existsSync(path.join(candidate, ...dependency.split("/"))),
    ),
  );
  if (!dependencyRoot) {
    fail("无法定位 Airalogy BD 的运行依赖，请重新执行 pnpm install");
  }
  return dependencyRoot;
}

function runtimeDashboardDirectory({ prepare, name = "dashboard" }) {
  const runtimeDirectory = process.env.BD_RUNTIME_DIRECTORY || path.join(process.cwd(), ".airalogy-bd", name);
  if (!prepare) {
    if (!existsSync(path.join(runtimeDirectory, ".next", "BUILD_ID"))) {
      fail("尚未找到已构建的工作台，请先运行 bd build");
    }
    return runtimeDirectory;
  }

  rmSync(runtimeDirectory, { recursive: true, force: true });
  mkdirSync(path.dirname(runtimeDirectory), { recursive: true });
  cpSync(dashboardSourceDirectory, runtimeDirectory, {
    recursive: true,
    filter: (source) => {
      const name = path.basename(source);
      return name !== ".next" && name !== "tsconfig.tsbuildinfo";
    },
  });
  writeFileSync(path.join(runtimeDirectory, "app", "lib", "build-info.json"), JSON.stringify(createBuildInfo(packageRoot), null, 2) + "\n");
  symlinkSync(
    dependencyDirectory(),
    path.join(runtimeDirectory, "node_modules"),
    "dir",
  );
  return runtimeDirectory;
}

function workspaceRequest(contentDirectory, request) {
  const result = spawnSync("uv", ["run", "--cache-dir", cacheDirectory, "--locked", path.join(scriptsDirectory, "workspace_service.py"), "--content-dir", contentDirectory], {input:JSON.stringify(request), encoding:"utf8", maxBuffer:12_000_000});
  if (result.error || result.status !== 0) fail("数据服务未能执行，请检查 uv 和 Git 环境。");
  const response = JSON.parse(result.stdout);
  if (!response.ok) fail(response.error);
  return response.result;
}

function runNext(command, contentDirectory, forwardedArguments) {
  const sourceDevelopment = command === "dev" && forwardedArguments.includes("--source");
  if (sourceDevelopment) forwardedArguments = forwardedArguments.filter(argument => argument !== "--source");
  const serverMode = process.env.BD_MODE === "server";
  if (process.env.BD_MODE && !["local","server"].includes(process.env.BD_MODE)) fail("BD_MODE 只支持 local 或 server。");
  if (serverMode && command !== "build") {
    deploymentOrigin();
    if (!process.env.BETTER_AUTH_SECRET || process.env.BETTER_AUTH_SECRET.length < 32) fail("请配置至少 32 字符的 BETTER_AUTH_SECRET。");
    if (command !== "start") fail("服务器模式请使用 bd build 构建后运行 bd start。");
    if (!existsSync(path.join(path.dirname(contentDirectory), ".bd-auth", "accounts.sqlite3")) || !workspaceRequest(contentDirectory,{action:"account_status"}).initialized) fail("请先使用 bd account-init 初始化管理员。");
  }
  if (command !== "build") workspaceRequest(contentDirectory, {action:"checkpoint",origin:"checkpoint",label:"启动工作台时留存资料",force:true});
  const dataFile = command === "build" ? generateData(contentDirectory) : path.join(contentDirectory,"generated","dashboard.json");
  // Let Next.js watch the real source tree and manage Fast Refresh itself.
  // Installed workspaces and production builds retain their isolated runtime.
  const dashboardDirectory = sourceDevelopment ? dashboardSourceDirectory : runtimeDashboardDirectory({prepare:command !== "start"});
  const nextBinary = require.resolve("next/dist/bin/next");
  const env = {...process.env, BD_DATA_FILE:dataFile, BD_CONTENT_DIR:contentDirectory, BD_SERVICE_FILE:path.join(scriptsDirectory,"workspace_service.py"), BD_CACHE_DIR:cacheDirectory, BD_CSRF_TOKEN:randomBytes(32).toString("hex"), NEXT_PUBLIC_BD_DEV_BUILD_INFO:sourceDevelopment ? JSON.stringify(createBuildInfo(packageRoot)) : ""};
  const bundler = command !== "start" && !forwardedArguments.some(x=>["--webpack","--turbopack","--turbo"].includes(x)) ? ["--webpack"] : [];
  if (command === "build") {run(process.execPath,[nextBinary,command,dashboardDirectory,...bundler,...forwardedArguments],{env});return;}
  const hosts = forwardedArguments.flatMap((arg,index) => ["--hostname","-H"].includes(arg) ? [forwardedArguments[index+1]] : arg.startsWith("--hostname=") ? [arg.slice(11)] : arg.startsWith("-H") ? [arg.slice(2)] : []);
  const suppliedHost = hosts.length > 0;
  if (!serverMode && hosts.some(host => !["localhost","127.0.0.1","::1"].includes(host))) fail("本地模式只允许绑定本机地址；对外服务请配置服务器模式和登录账号。");
  if (sourceDevelopment) console.log("源码开发模式：由 Next.js 自动刷新，编译缓存保存在 dashboard/.next。");
  const watcher = spawn(process.execPath,[path.join(scriptsDirectory,"watch-content.mjs")],{env,stdio:"inherit"});
  const server = spawn(process.execPath,[nextBinary,command,dashboardDirectory,...bundler,...(!suppliedHost ? ["--hostname","127.0.0.1"] : []),...forwardedArguments],{env,stdio:"inherit"});
  const stop = signal => {watcher.kill(signal);server.kill(signal);};
  process.once("SIGINT",() => stop("SIGINT"));
  process.once("SIGTERM",() => stop("SIGTERM"));
  server.once("error",error => {watcher.kill();fail(error.message);});
  server.once("close",code => {watcher.kill();process.exitCode=code ?? 0;});
}

function deploymentOrigin() {
  try {
    const url = new URL(process.env.BD_PUBLIC_URL || "");
    const test = process.env.BD_ALLOW_INSECURE_LOOPBACK === "1" && url.protocol === "http:" && ["localhost","127.0.0.1","[::1]"].includes(url.hostname);
    if ((!test && url.protocol !== "https:") || url.pathname !== "/" || url.search || url.hash || url.username || url.password) throw new Error();
    return url.origin;
  } catch { fail("请将 BD_PUBLIC_URL 设置为 HTTPS 访问地址，例如 https://bd.example.com。"); }
}

function printHelp() {
  console.log(`Airalogy BD

用法：
  bd init [--id <工作区ID>] [--name <公司名称>] [--source]
  bd launch
  bd validate [--content <dir>]
  bd data [--content <dir>]
  bd dev [--source] [--content <dir>] [Next.js options]
  bd build [--content <dir>] [Next.js options]
  bd start [--content <dir>] [Next.js options]
  bd lint
  bd checkpoint [--content <dir>] [--label <说明>]
  bd backup --output <备份.zip> [--content <dir>]
  bd restore-backup --archive <备份.zip> --destination <新目录>
  bd edit [--content <dir>] [--label <说明>] -- <command> [args...]
  bd backup-auto [--content <dir>]
  bd account-init --email <邮箱> --name <姓名>
  bd account-recover --email <邮箱>

默认读取当前目录下的 content/。`);
}

const [command = "help", ...rawArguments] = process.argv.slice(2);
const { contentDirectory, remaining } = parseArguments(rawArguments);

switch (command) {
  case "account-init":
  case "account-recover": {
    const origin = deploymentOrigin();
    const option = key => {const index=remaining.indexOf(key);return index < 0 ? undefined : remaining[index+1];};
    const email=option("--email"),name=option("--name");
    if (!email || (command === "account-init" && !name)) fail("请提供 --email；初始化还需要 --name。");
    const result=workspaceRequest(contentDirectory,{action:command.replace("-","_"),email,name});
    console.log(`请将下面的一次性链接交给账号本人，48 小时内设置密码及验证器：\n${origin}/join#${result.token}`);
    break;
  }
  case "init": {
    const option = key => { const index = remaining.indexOf(key); if (index < 0) return undefined; if (!remaining[index + 1] || remaining[index + 1].startsWith("--")) fail(`${key} 需要提供值`); return remaining[index + 1]; };
    if (contentDirectory !== path.join(process.cwd(), "content")) fail("bd init 请在工作区根目录执行，使用默认 content/。");
    try { initializeWorkspace(process.cwd(), packageRoot, {id: option("--id"), name: option("--name"), source: remaining.includes("--source")}); }
    catch (error) { fail(error.message); }
    console.log("工作区已初始化，现有文件已保留。运行 pnpm install 后，可双击 启动 Airalogy BD.command。");
    break;
  }
  case "launch": {
    if (contentDirectory !== path.join(process.cwd(), "content")) fail("bd launch 请在工作区根目录执行，使用默认 content/。");
    try { await launchWorkspace({cli: fileURLToPath(import.meta.url)}); }
    catch (error) { fail(error.message); }
    break;
  }
  case "migrate-layout": {
    const result = workspaceRequest(contentDirectory, {action:"migrate_layout",apply:remaining.includes("--apply")});
    console.log(JSON.stringify(result,null,2));
    break;
  }
  case "validate":
    runPythonScript("validate.py", contentDirectory);
    break;
  case "data": {
    const status=workspaceRequest(contentDirectory,{action:"checkpoint",origin:"checkpoint",label:"汇总前留存资料",force:true});
    if (status.errors.length) fail("当前文件已留存，但资料校验未通过：\n" + status.errors.join("\n"));
    const data=JSON.parse(readFileSync(path.join(contentDirectory,"generated","dashboard.json"),"utf8"));
    console.log(`看板数据已更新：${data.projects.length} 个项目，${data.people.length} 位人员，${data.projects.reduce((sum,project)=>sum+project.contacts.length,0)} 条项目人员关系，${data.projects.reduce((sum,project)=>sum+project.events.length,0)} 条项目事件，${data.company_events.length} 条公司事件。`);
    break;
  }
  case "dev":
  case "build":
  case "start":
    runNext(command, contentDirectory, remaining);
    break;
  case "backup": {
    const outputIndex = remaining.indexOf("--output");
    if (outputIndex < 0 || !remaining[outputIndex + 1]) fail("请用 --output 指定备份文件。");
    const destination = path.resolve(remaining[outputIndex + 1]);
    if (existsSync(destination)) fail("备份目标已存在，请使用新的文件名。");
    const backup = workspaceRequest(contentDirectory, {action:"file_backup"});
    const download = workspaceRequest(contentDirectory, {action:"backup_download",id:backup.id});
    cpSync(download.path, destination, {force:false,errorOnExist:true});
    console.log(`完整备份已保存：${destination}`);
    break;
  }
  case "restore-backup": {
    const archiveIndex = remaining.indexOf("--archive"), destinationIndex = remaining.indexOf("--destination");
    if (archiveIndex < 0 || destinationIndex < 0 || !remaining[archiveIndex + 1] || !remaining[destinationIndex + 1]) fail("请指定备份文件和新的恢复目录。");
    const restored = workspaceRequest(contentDirectory, {action:"restore_backup",archive:path.resolve(remaining[archiveIndex + 1]),destination:path.resolve(remaining[destinationIndex + 1])});
    console.log(`${restored.message} ${restored.directory}`);
    break;
  }
  case "checkpoint": {
    const labelIndex=remaining.indexOf("--label");
    const status=workspaceRequest(contentDirectory,{action:"checkpoint",origin:"checkpoint",label:labelIndex >= 0 ? remaining[labelIndex+1] || "手动留存资料" : "手动留存资料"});
    console.log(status.errors.length ? "当前文件已留存，但有格式问题：\n" + status.errors.join("\n") : "当前资料已留存可恢复版本。");
    break;
  }
  case "backup-auto": {
    const result=workspaceRequest(contentDirectory,{action:"backup_tick"});
    console.log(result.error || (result.last_success ? `最近备份：${result.last_success.path}` : "尚未启用自动备份。"));
    if(result.error) process.exitCode=1;
    break;
  }
  case "edit": {
    const delimiter=remaining.indexOf("--");
    const options=delimiter >= 0 ? remaining.slice(0,delimiter) : [];
    const labelIndex=options.indexOf("--label");
    const label=labelIndex >= 0 ? options[labelIndex+1] : "直接编辑";
    const argumentsToRun=delimiter >= 0 ? remaining.slice(delimiter+1) : remaining;
    if (!argumentsToRun.length) fail("bd edit 需要指定编辑命令。");
    workspaceRequest(contentDirectory,{action:"checkpoint",origin:"checkpoint",label:`${label}：编辑前`});
    const result=spawnSync(argumentsToRun[0],argumentsToRun.slice(1),{stdio:"inherit"});
    const status=workspaceRequest(contentDirectory,{action:"checkpoint",origin:"external",label:`${label}：编辑后`});
    const backup=workspaceRequest(contentDirectory,{action:"backup_tick"});
    if(backup.error) console.error(`资料已留存，但备份未完成：${backup.error}`);
    if (status.errors.length) console.error("编辑结果已留存，但校验未通过：\n" + status.errors.join("\n"));
    if (result.error) console.error(result.error.message);
    process.exitCode=result.status || (result.error || status.errors.length ? 1 : 0);
    break;
  }
  case "lint": {
    const dashboardDirectory = runtimeDashboardDirectory({
      prepare: true,
      name: "lint-dashboard",
    });
    const eslintBinary = path.join(
      path.dirname(require.resolve("eslint/package.json")),
      "bin",
      "eslint.js",
    );
    run(
      process.execPath,
      [
        eslintBinary,
        ".",
        "--ignore-pattern",
        "dist",
        "--ignore-pattern",
        ".next",
      ],
      { cwd: dashboardDirectory },
    );
    break;
  }
  case "help":
  case "--help":
  case "-h":
    printHelp();
    break;
  default:
    fail(`未知命令：${command}。运行 bd --help 查看用法。`);
}
