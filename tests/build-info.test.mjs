import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createBuildInfo } from "../bin/build-info.mjs";

test("software identity follows executable sources rather than company data, caches or build time", () => {
  const root = mkdtempSync(path.join(tmpdir(), "bd-version-"));
  const put = (name, value) => { const filename = path.join(root, name); mkdirSync(path.dirname(filename), {recursive:true}); writeFileSync(filename, value); };
  try {
    put("package.json", JSON.stringify({version:"1.2.3"}));
    put("dashboard/app/page.tsx", "original page");
    put("scripts/service.py", "original service");
    const first = createBuildInfo(root);
    assert.equal(first.version,"1.2.3");
    assert.equal(first.channel,"installed");
    assert.match(first.build_id,/^[0-9a-f]{12}$/);
    assert.ok(Number.isFinite(Date.parse(first.built_at)));
    put("content/people.yaml","changed business content");
    put("dashboard/.next/cache/test","changed generated output");
    put("scripts/__pycache__/service.pyc","python cache");
    put("dashboard/node_modules/dependency/index.js","dependency symlink substitute");
    put("README.md","documentation edit");
    assert.equal(createBuildInfo(root).build_id,first.build_id);
    put("dashboard/app/page.tsx","updated page");
    const ui = createBuildInfo(root);
    assert.notEqual(ui.build_id,first.build_id);
    put("scripts/service.py","updated service");
    const service = createBuildInfo(root);
    assert.notEqual(service.build_id,ui.build_id);
    put("pnpm-lock.yaml","updated dependencies");
    assert.notEqual(createBuildInfo(root).build_id,service.build_id);
    mkdirSync(path.join(root,".git"));
    assert.equal(createBuildInfo(root).channel,"local");
    // An already captured build identity remains fixed after later source edits.
    assert.equal(first.version,"1.2.3");
    assert.notEqual(createBuildInfo(root).build_id,first.build_id);
  } finally {rmSync(root,{recursive:true,force:true});}
});
