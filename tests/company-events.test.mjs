import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../dashboard/app/lib/company-events.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const { filterCompanyEvents, companyCategoryLabel } = await import(
  "data:text/javascript;base64," + Buffer.from(outputText).toString("base64")
);
const events = [
  { id: "early", date: "2026-07-01", title: "首次路演", summary: "融资交流", category: "fundraising", participants: ["林青"], organizers: ["创新中心"] },
  { id: "later", date: "2026-09-22", title: "Innovation Expo", summary: "参与展示", category: "industry-recognition", participants: ["陈宁"], related_document: { markdown: "入选创新榜单，现场讨论生命科学" } },
];
const defaults = { query: "", category: "all", from: "", to: "" };

test("company events search covers records, people, organizers and translated categories", () => {
  for (const query of ["  INNOVATION expo ", "生命科学", "行业活动", "陈宁"]) {
    assert.deepEqual(filterCompanyEvents(events, { ...defaults, query }).map(e => e.id), ["later"]);
  }
  assert.equal(filterCompanyEvents(events, { ...defaults, query: "创新中心 林青" })[0].id, "early");
  assert.deepEqual(filterCompanyEvents(events, { ...defaults, query: "不存在" }), []);
});
test("category and inclusive date range combine without mutating source order", () => {
  assert.deepEqual(filterCompanyEvents(events, defaults).map(e => e.id), ["later", "early"]);
  assert.equal(events[0].id, "early");
  assert.equal(filterCompanyEvents(events, { ...defaults, from: "2026-09-22", to: "2026-09-22" }).length, 1);
  assert.equal(filterCompanyEvents(events, { ...defaults, category: "fundraising", from: "2026-09-01" }).length, 0);
  assert.equal(filterCompanyEvents(events, { ...defaults, from: "2026-09-23", to: "2026-09-01" }).length, 0);
  assert.deepEqual(filterCompanyEvents([], defaults), []);
  assert.equal(companyCategoryLabel("自定义活动"), "自定义活动");
});
