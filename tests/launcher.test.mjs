import assert from "node:assert/strict";
import {mkdtempSync, readFileSync, rmSync, statSync, writeFileSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {tmpdir} from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import test from "node:test";
import {initializeWorkspace} from "../bin/init.mjs";
import {launchWorkspace} from "../bin/launch.mjs";
const root = fileURLToPath(new URL("..", import.meta.url));

test("initialization preserves existing content and creates a relocatable executable launcher", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "bd init 空格 $-"));
  try {
    initializeWorkspace(directory, root, {id: "test-company", name: "虚构公司"});
    const config = JSON.parse(readFileSync(path.join(directory, "content/workspace.yaml"), "utf8"));
    assert.equal(config.name, "虚构公司");
    writeFileSync(path.join(directory, "content/people.yaml"), "people: [existing]\n");
    initializeWorkspace(directory, root);
    assert.equal(readFileSync(path.join(directory, "content/people.yaml"), "utf8"), "people: [existing]\n");
    assert.equal(JSON.parse(readFileSync(path.join(directory, "content/workspace.yaml"), "utf8")).id, "test-company");
    const launcher = path.join(directory, "启动 Airalogy BD.command");
    assert.ok(statSync(launcher).mode & 0o111);
    assert.equal(spawnSync("bash", ["-n", launcher]).status, 0);
    assert.ok(!readFileSync(launcher, "utf8").includes(directory));
    const failure = spawnSync("bash", [launcher], {cwd: tmpdir(), input: "\n", encoding: "utf8"});
    assert.equal(failure.status, 1);
    assert.ok(failure.stdout.includes("pnpm install"));
  } finally { rmSync(directory, {recursive: true, force: true}); }
});

test("launch opens only when ready, reuses an existing instance and reports startup failure", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "bd-launch-test-"));
  const cli = path.join(directory, "fake-cli.mjs");
  const urls = [];
  try {
    writeFileSync(cli, `import http from 'node:http';
const port=Number(process.argv.at(-1));
const started=Date.now();
const server=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,result:{status:{errors:Date.now()-started < 600 ? ['starting'] : []}}}));});
server.listen(port,'127.0.0.1');
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
setTimeout(()=>server.close(()=>process.exit(0)),3000);
`);
    const first = launchWorkspace({cli, workspace: directory, openBrowser: url => urls.push(url), timeoutMs: 5000});
    const deadline = Date.now() + 6000;
    while (!urls.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(urls.length, 1, "server must become ready and open the browser");
    const second = await launchWorkspace({cli, workspace: directory, openBrowser: url => urls.push(url), timeoutMs: 5000});
    assert.equal(second.reused, true);
    assert.equal(urls.length, 2);
    assert.equal(urls[0], urls[1]);
    assert.equal((await first).reused, false);
    writeFileSync(cli, "process.exit(2);\n");
    await assert.rejects(launchWorkspace({cli, workspace: directory, openBrowser: () => assert.fail("failed process must not open browser"), timeoutMs: 5000}), /退出码 2/);
  } finally {rmSync(directory, {recursive: true, force: true});}
});
