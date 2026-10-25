import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkPublication, inspectPublicationFile } from "../scripts/check-publication.mjs";

test("publication gate rejects private data, personal metadata and symlinks without printing values", () => {
  for (const file of [".env", "dashboard/.env.local", "content/people.yaml", ".bd-auth/team.sqlite", ".airalogy-bd/launcher-lock/state.json", "dashboard/.airalogy-bd/runtime.json", "scripts/private.key", "docs/contract.docx", "fixtures/demo/content/generated/dashboard.json", "dashboard/debug.log", ".pnpm-store/cache.json"]) {
    assert.ok(inspectPublicationFile(file, Buffer.from("sensitive")).length, file);
  }
  const home = "/" + "Users/" + "private-user/project/file";
  const email = "person" + "@" + "private-company.com";
  const key = "-----BEGIN " + "PRIVATE KEY-----";
  for (const secret of [home, email, key]) {
    const issues = inspectPublicationFile("README.md", Buffer.from(secret));
    assert.ok(issues.length);
    assert.ok(!issues.join().includes(secret));
  }
  assert.ok(inspectPublicationFile("linked.txt", Buffer.alloc(0), { symlink: true }).length);
  assert.ok(inspectPublicationFile("image.bin", Buffer.from([0, 1, 2])).length);
  assert.ok(inspectPublicationFile("dashboard/app/lib/build-info.json", Buffer.from('{"revision":"abcdef1"}')).length);
  for (const file of ["deploy/.env.example", "fixtures/demo/content/people.yaml", "docs/server-deployment.md"]) {
    assert.deepEqual(inspectPublicationFile(file, Buffer.from("admin@example.com demo@example.invalid")), []);
  }
});

test("publication gate checks renamed and untracked files without failing on a deleted source", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "bd-renamed-source-"));
  try {
    execFileSync("git", ["init", "--quiet", directory]);
    writeFileSync(path.join(directory, "source.md"), "example\n");
    execFileSync("git", ["-C", directory, "add", "source.md"]);
    rmSync(path.join(directory, "source.md"));
    writeFileSync(path.join(directory, "renamed.md"), "example\n");
    assert.equal(checkPublication(directory), 1);
    writeFileSync(path.join(directory, ".env"), "SYNTHETIC_PRIVATE_PROBE_ONLY\n");
    assert.throws(() => checkPublication(directory), /private data/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("actual npm package includes source but excludes private files inside source directories", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "bd-package-policy-"));
  const keep = ["dashboard/public/airalogy-logo.svg","LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md", "docs/dependency-licenses.json", "bin/bd.mjs", "dashboard/app/page.tsx", "dashboard/app/api/ai/route.ts", "dashboard/app/lib/build-info.json", "scripts/workspace_service.py", "scripts/workspace_service.py.lock", "docs/versioning.md"];
  const privateFiles = ["bin/.env.local", "dashboard/app/.bd-ai/settings.db", "dashboard/app/.bd-ai/settings.json", "dashboard/app/.airalogy-bd/state.json", "scripts/fixture.key", "scripts/__pycache__/probe.pyc", "docs/attachments/probe.docx", "content/people.yaml"];
  try {
    const source = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    assert.equal(source.license, "Apache-2.0");
    writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name: "synthetic-package-policy", version: "1.0.0", files: source.files, bin: source.bin }));
    writeFileSync(path.join(directory, ".npmignore"), readFileSync(new URL("../.npmignore", import.meta.url)));
    for (const file of [...keep, ...privateFiles]) {
      const target = path.join(directory, file); mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, "SYNTHETIC_PACKAGING_PROBE_ONLY\n");
    }
    const manifest = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json", "--cache", path.join(directory, ".cache")], { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }))[0];
    const files = manifest.files.map(file => file.path);
    for (const file of keep) assert.ok(files.includes(file), file);
    for (const file of privateFiles) assert.ok(!files.includes(file), file);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
