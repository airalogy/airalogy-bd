import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
test("contact channel validation accepts optional strings and rejects malformed or duplicated fields", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "bd-contact-schema-"));
  const content = path.join(dir, "content");
  try {
    await cp(path.join(root, "fixtures/demo/content"), content, { recursive: true });
    const peopleFile = path.join(content, "people.yaml");
    const original = await readFile(peopleFile, "utf8");
    const validate = () => spawnSync(process.execPath, [path.join(root, "bin/bd.mjs"), "validate", "--content", content], { cwd: root, encoding: "utf8" });
    const baseline = validate();
    assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
    for (const [from, to, field] of [
      ['phone: "010-00000000"', "phone: 123456", "phone"],
      ["wechat: demo_chenqing", "wechat: [one, two]", "wechat"],
      ["email: chenqing@example.invalid", "email: invalid-address", "email"],
      ['phone: "010-00000000"', 'phone: "first\\nsecond"', "phone"],
    ]) {
      await writeFile(peopleFile, original.replace(from, to));
      const result = validate();
      assert.notEqual(result.status, 0, "must reject " + field);
      assert.ok((result.stdout + result.stderr).includes(field));
    }
    await writeFile(peopleFile, original);
    const relationFile = path.join(content, "counterparties/星帆创投/matters/融资对接/contacts.yaml");
    const relation = await readFile(relationFile, "utf8");
    for (const field of ["phone", "wechat", "email"]) {
      await writeFile(relationFile, relation.replace("person_id: 陈青", "person_id: 陈青\n    " + field + ": null"));
      const result = validate();
      assert.notEqual(result.status, 0);
      assert.ok((result.stdout + result.stderr).includes(field));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
