import { watch } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";

const content = process.env.BD_CONTENT_DIR;
const service = process.env.BD_SERVICE_FILE;
let active = false;
let pending = false;
let debounce;
let child;
let backupChild;
function backup() {
  if (backupChild) return;
  backupChild = spawn("uv", ["run", "--cache-dir", process.env.BD_CACHE_DIR, "--locked", service, "--content-dir", content], {stdio:["pipe","ignore","ignore"]});
  const done = () => {backupChild = null;};
  backupChild.once("error",done);backupChild.once("close",done);
  backupChild.stdin.on("error",()=>{});
  backupChild.stdin.end(JSON.stringify({action:"backup_tick"}));
}
function capture() {
  if (active) {pending = true;return;}
  active = true;
  child = spawn("uv", ["run", "--cache-dir", process.env.BD_CACHE_DIR, "--locked", service, "--content-dir", content], {stdio:["pipe","ignore","pipe"]});
  child.stderr.resume();
  let ended = false;
  const finished = () => {if(ended)return;ended=true;active = false;if (pending) {pending = false;capture();}};
  child.once("error", finished);
  child.once("close", finished);
  child.stdin.on("error",()=>{});
  child.stdin.end(JSON.stringify({action:"checkpoint",origin:"external",label:"记录文件修改"}));
}
const watcher = watch(content,{recursive:true},(_event, name) => {
  if (!name || /^(?:projects|counterparties)[\/\\][^\/\\]+[\/\\]attachments(?:[\/\\]|$)/.test(name) || name.split(path.sep).includes("generated") || !/\.(md|ya?ml)$/.test(name)) return;
  clearTimeout(debounce);
  debounce = setTimeout(capture,150);
});
watcher.on("error",()=>console.error("文件监听暂不可用，将继续定期检查资料修改。"));
// Polling also catches complete directory replacement, missed events and watcher gaps.
const interval = setInterval(capture,5000);
capture();
const backupInterval = setInterval(backup,60000);
backup();
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;pending = false;
  clearInterval(interval);clearInterval(backupInterval);clearTimeout(debounce);watcher.close();child?.kill();
  if (!backupChild) {process.exit(0);return;}
  // Allow the verified local copy / in-flight OSS upload to finish during shutdown.
  backupChild.once("close",()=>process.exit(0));
  setTimeout(()=>{backupChild?.kill();process.exit(0);},245000).unref();
}
process.on("SIGTERM",stop);
process.on("SIGINT",stop);
