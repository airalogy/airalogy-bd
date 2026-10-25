import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { checkVersion } from "../scripts/check-version.mjs";

test("version gate rejects mismatched, duplicate, undated or empty version entries", () => {
  const root = mkdtempSync(path.join(tmpdir(), "bd-version-policy-"));
  const write = (version, changelog) => {
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ version }));
    writeFileSync(path.join(root, "CHANGELOG.md"), changelog);
  };
  try {
    const entry = "## [1.1.0] - 2026-10-22\n\n示例功能。\n";
    write("1.1.0", "# 更新记录\n\n## [Unreleased]\n\n" + entry);
    assert.equal(checkVersion(root), "1.1.0");
    for (const version of ["1.1.0-dev.1", "v1.1.0", "1.01.0", "1.1", null]) {
      write(version, entry); assert.throws(() => checkVersion(root), /x.y.z/);
    }
    write("1.1.1", entry); assert.throws(() => checkVersion(root), /一致/);
    write("1.1.0", entry + "\n" + entry); assert.throws(() => checkVersion(root), /一次/);
    write("1.1.0", "## [1.1.0] - 2026-02-30\n\n修复。\n"); assert.throws(() => checkVersion(root), /真实/);
    write("1.1.0", "## [1.1.0]\n\n修复。\n"); assert.throws(() => checkVersion(root), /一致/);
    write("1.1.0", "## [1.1.0] - 2026-10-22\n\n## [1.0.0] - 2026-10-01\n\n示例首发内容。\n"); assert.throws(() => checkVersion(root), /更新内容/);
    write("1.0.0", "## [1.0.0] - 2026-10-22\n\n稳定交付版本。\n"); assert.equal(checkVersion(root), "1.0.0");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
