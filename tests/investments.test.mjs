import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../dashboard/app/lib/investments.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
});
const { filterInvestments, externalContacts, needsContactInfo, csvCell } = await import(
  "data:text/javascript;base64," + Buffer.from(outputText).toString("base64")
);
const defaults = { query: "", followUp: "all", priority: "all", stage: "all", missingContact: false, sort: "follow_up" };
const base = { name: "示例机构", record_type: "investment", counterparties: ["示例基金"], owner: "负责人", summary: "评估中", next_action: "安排交流", source_note: "介绍认识", sourced_by: ["顾问"], stage: "initial_contact", priority: "medium", last_activity: "2026-01-12" };
const contacts = [
  { person_id: "甲", name: "甲", side: "counterparty", affiliation: "示例基金投资经理", phone: "+86 010-00000000", email: "demo@example.invalid", wechat: "demo_wechat", notes: "" },
  { person_id: "乙", name: "乙", side: "counterparty", affiliation: "示例基金合伙人", notes: "" },
  { person_id: "顾问", name: "顾问", side: "advisor", notes: "" },
  { person_id: "内部", name: "内部", side: "internal", notes: "", phone: "internal-only" },
];
const projects = [
  { ...base, id: "closed", follow_up_status: "closed", contacts: [], last_activity: "2026-02-01" },
  { ...base, id: "active", follow_up_status: "active_progress", contacts: [contacts[0], contacts[3]], priority: "high" },
  { ...base, id: "proactive", follow_up_status: "proactive_contact", contacts },
  { ...base, id: "cooperation", record_type: "cooperation", follow_up_status: "proactive_contact", contacts },
];
test("investment overview preserves institution relationships and excludes internal contacts", () => {
  assert.deepEqual(externalContacts(projects[2]).map(p => p.person_id), ["甲", "乙", "顾问"]);
  assert.deepEqual(filterInvestments(projects, defaults).map(p => p.id), ["proactive", "active", "closed"]);
  assert.equal(projects[0].id, "closed");
  assert.equal(filterInvestments(projects, { ...defaults, query: "internal-only" }).length, 0);
});
test("search matches multiple contacts, channels and combined institution terms", () => {
  for (const query of ["示例基金 乙", "DEMO@EXAMPLE.INVALID", "demo_wechat", "+86 010", "顾问", "安排交流"]) {
    assert.ok(filterInvestments(projects, { ...defaults, query }).some(p => p.id === "proactive"), query);
  }
  assert.equal(filterInvestments(projects, { ...defaults, query: "不存在" }).length, 0);
});
test("filters combine, missing contacts are not mistaken for complete profiles", () => {
  assert.equal(needsContactInfo(projects[0]), true);
  assert.equal(needsContactInfo(projects[1]), false);
  assert.equal(needsContactInfo(projects[2]), true);
  assert.deepEqual(filterInvestments(projects, { ...defaults, missingContact: true }).map(p => p.id), ["proactive", "closed"]);
  assert.equal(filterInvestments(projects, { ...defaults, followUp: "active_progress", priority: "high", stage: "initial_contact" })[0].id, "active");
  assert.equal(filterInvestments(projects, { ...defaults, stage: "signed" }).length, 0);
  assert.equal(filterInvestments(projects, { ...defaults, sort: "recent" })[0].id, "closed");
  assert.equal(filterInvestments(projects, { ...defaults, sort: "stale" }).at(-1).id, "closed");
  assert.deepEqual(filterInvestments([], defaults), []);
});
test("CSV escapes quotes and prevents spreadsheet formula execution", () => {
  assert.equal(csvCell('甲,"乙"\n丙'), '"甲,""乙""\n丙"');
  for (const text of ["=1+1", "+86 010-00000000", "-1", "@SUM(A1)", "  =1+1", "\t=1"]) assert.ok(csvCell(text).startsWith('"\''), text);
  assert.equal(csvCell(null), '""');
});
test("generated shared profile channels propagate to every project without losing multiple contacts", async () => {
  const data = JSON.parse(await readFile(new URL("../fixtures/demo/content/generated/dashboard.json", import.meta.url), "utf8"));
  const person = data.people.find(person => person.id === "陈青");
  assert.equal(person.phone, "010-00000000");
  assert.equal(person.wechat, "demo_chenqing");
  assert.equal(person.email, "chenqing@example.invalid");
  const related = data.projects.filter(project => project.contacts.some(contact => contact.person_id === person.id));
  assert.equal(related.length, 2);
  for (const project of related) {
    const contact = project.contacts.find(contact => contact.person_id === person.id);
    assert.equal(contact.phone, person.phone);
    assert.equal(contact.wechat, person.wechat);
    assert.equal(contact.email, person.email);
  }
  assert.equal(externalContacts(data.projects.find(project => project.id === "project-demo-investment")).length, 3);
});
