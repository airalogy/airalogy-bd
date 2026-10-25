import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import test from "node:test";
import ts from "typescript";

async function load(relative, modules, process) {
  const source = await readFile(new URL(relative, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } });
  const exports = {};
  new Function("require", "exports", "process", outputText)(id => {
    assert.ok(id in modules, id);
    return modules[id];
  }, exports, process);
  return exports;
}

test("file managers receive paths as arguments, with failures reported to the UI", async () => {
  const filename = "/archive/示例机构/协议 $(touch nope); 'quote'.docx";
  for (const [platform, command, args] of [
    ["darwin", "open", ["-R", filename]],
    ["win32", "explorer.exe", [`/select,${filename}`]],
    ["linux", "xdg-open", [path.dirname(filename)]],
    ["unsupported", null, null],
  ]) {
    let fail = false, calls = 0;
    const { revealFile } = await load("../dashboard/app/lib/reveal-file.ts", {
      "server-only": {}, "node:path": path,
      "node:child_process": {execFile: (actualCommand, actualArgs, options, callback) => {
        calls++;
        assert.equal(actualCommand, command);assert.deepEqual(actualArgs, args);
        assert.equal(options.shell, undefined);assert.equal(options.timeout, 10000);
        callback(fail ? new Error("desktop unavailable") : null);
      }},
    }, {platform});
    assert.equal((await revealFile(filename)).ok, command !== null);
    assert.equal(calls, command ? 1 : 0);
    fail = true;
    assert.equal((await revealFile(filename)).code, "unavailable");
  }
});

test("revealing files requires local origin and CSRF and only forwards indexed IDs", async () => {
  const resolved = "/workspace/content/counterparties/示例机构/attachments/agreements/v1.docx";
  let serviceCalls = [], opens = [], missing = false, openFailure = false;
  const transport = {
      isLocalRequest: request => new URL(request.url).hostname === "127.0.0.1" && (!request.headers.get("host") || request.headers.get("host") === "127.0.0.1:3000"),
      invokeWorkspace: async input => {serviceCalls.push(input);return missing ? {ok:false,code:"not_found",error:"找不到文件"} : {ok:true,result:{path:resolved}};},
    };
  const environment={env:{BD_CSRF_TOKEN:"test-token"}};
  const authorization=await load("../dashboard/app/lib/server-auth.ts", {"server-only":{},"node:crypto":{timingSafeEqual},"next/headers":{},"./workspace-server":transport}, environment);
  const { POST, GET } = await load("../dashboard/app/api/files/route.ts", {
    "node:fs": {}, "node:stream": {},
    "../../lib/workspace-server": transport,
    "../../lib/server-auth": authorization,
    "../../lib/reveal-file": {revealFile: async filename => {opens.push(filename);return openFailure ? {ok:false,code:"unavailable",error:"无法打开"} : {ok:true,result:{message:"已打开"}};}},
  }, environment);
  const body = {action:"file_reveal",id:"file-1",version_id:"version-1",path:"/etc/passwd",snapshot:"untrusted"};
  const post = (extra={}, input=body) => POST(new Request("http://127.0.0.1:3000/api/files", {method:"POST",headers:{host:"127.0.0.1:3000",origin:"http://127.0.0.1:3000","x-bd-csrf":"test-token","content-type":"application/json",...extra},body:JSON.stringify(input)}));
  for (const headers of [{origin:""},{origin:"https://evil.example"},{"x-bd-csrf":""},{"sec-fetch-site":"cross-site"},{host:"evil.example"}]) assert.equal((await post(headers)).status,403);
  assert.equal(serviceCalls.length,0);assert.equal(opens.length,0);
  assert.equal((await GET(new Request("http://127.0.0.1:3000/api/files?action=file_reveal"))).status,400);
  assert.equal((await post()).status,200);
  assert.deepEqual(serviceCalls[0],{action:"file_location",id:"file-1",version_id:"version-1",record_id:undefined});
  assert.deepEqual(opens,[resolved]);
  missing = true;
  assert.equal((await post()).status,404);assert.equal(opens.length,1);
  missing = false;openFailure = true;
  const failed = await post({}, {action:"file_reveal",id:"file-1",record_id:"use-1"});
  assert.equal((await failed.json()).ok,false);
  assert.equal(serviceCalls.at(-1).record_id,"use-1");
});
