import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));

test("empty workspaces generate data and accept their first person while rejecting malformed lists", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "bd-empty-workspace-"));
  const content = path.join(directory, "content");
  const validate = () => spawnSync(process.execPath, [path.join(root, "bin/bd.mjs"), "validate", "--content", content], {cwd: root, encoding: "utf8"});
  const request = (payload) => {
    const child = spawnSync("uv", ["run", "--offline", "--cache-dir", path.join(root, ".uv-cache"), "--locked", path.join(root, "scripts/workspace_service.py"), "--content-dir", content], {input: JSON.stringify(payload), encoding: "utf8"});
    assert.equal(child.status, 0, child.stderr);
    const response = JSON.parse(child.stdout);
    assert.equal(response.ok, true, JSON.stringify(response));
    return response.result;
  };
  try {
    cpSync(path.join(root, "fixtures/demo/content"), content, {recursive: true});
    rmSync(path.join(content, "generated"), {recursive: true, force: true});
    rmSync(path.join(content, "counterparties"), {recursive: true});
    // Keep the standard content layout, with no fabricated business records.
    mkdirSync(path.join(content, "counterparties"));
    rmSync(path.join(content, "company/records"), {recursive: true});
    mkdirSync(path.join(content, "company/records"));
    writeFileSync(path.join(content, "people.yaml"), "people: []\n");
    writeFileSync(path.join(content, "company/events.yaml"), "company: demo-company\nevents: []\n");
    const valid = validate();
    assert.equal(valid.status, 0, valid.stdout + valid.stderr);
    const workspace = request({action: "workspace"});
    for (const key of ["people", "projects", "company_events", "counterparties", "files"]) assert.deepEqual(workspace.data[key], []);
    assert.equal(workspace.data.updated_at, null);
    const form = request({action: "record", kind: "person", id: ""});
    request({action: "save", kind: "person", id: "", revision: form.revision, payload: {id: "测试人员", name: "测试人员", affiliation: "虚构测试单位"}});
    assert.equal(request({action: "workspace"}).data.people[0].name, "测试人员");
    for (const [file, invalidValues, field] of [
      ["people.yaml", ["{}\n", "people: null\n", "people: {}\n"], "people"],
      ["company/events.yaml", ["company: demo-company\n", "company: demo-company\nevents: null\n", "company: demo-company\nevents: {}\n"], "events"],
    ]) {
      const original = file === "people.yaml" ? "people: []\n" : "company: demo-company\nevents: []\n";
      for (const value of invalidValues) {
        writeFileSync(path.join(content, file), value);
        const invalid = validate();
        assert.notEqual(invalid.status, 0);
        assert.ok((invalid.stdout + invalid.stderr).includes(field));
      }
      writeFileSync(path.join(content, file), original);
    }
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
});
