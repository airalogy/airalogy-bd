import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import path from "node:path";
import {fileURLToPath} from "node:url";
import test from "node:test";
const root=fileURLToPath(new URL("..",import.meta.url));
test("account security, archive recovery and OSS failure tests",()=>{
  const result=spawnSync("uv",["run","--cache-dir",process.env.BD_TEST_CACHE||path.join(root,".uv-cache"),"--locked",path.join(root,"tests/team-security.py")],{encoding:"utf8",timeout:120000});
  assert.equal(result.status,0,result.stdout+result.stderr);
});
