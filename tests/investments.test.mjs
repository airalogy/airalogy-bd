import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function compile(relative, dependencies = {}) {
  const source = await readFile(new URL(relative, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const exports = {};
  new Function("require", "exports", outputText)(name => {
    assert.ok(name in dependencies, `Unexpected dependency: ${name}`);
    return dependencies[name];
  }, exports);
  return exports;
}
const labels = await compile("../dashboard/app/lib/labels.ts");
const { filterInvestments, externalContacts, needsContactInfo, csvCell, bpSendings } = await compile(
  "../dashboard/app/lib/investments.ts", {"./labels": labels},
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
test("unassigned owners can be found and exported without changing the original assignment", async () => {
  const owners = ["待确认", "", null, undefined, "未分配", "陈青"];
  const examples = owners.map((owner, index) => ({...projects[0], id: String(index), owner, events: []}));
  const original = structuredClone(examples);
  assert.deepEqual(filterInvestments(examples, {...defaults, query: "未分配"}).map(p => p.id), ["0", "1", "2", "3", "4"]);
  assert.deepEqual(filterInvestments(examples, {...defaults, query: "陈青"}).map(p => p.id), ["5"]);
  const {buildLeadershipReport} = await compile("../dashboard/app/lib/report.ts", {"./labels": labels});
  const report = buildLeadershipReport({data: {workspace: {short_name: "示例工作台"}}, projects: examples, companyEvents: [], scopeLabel: "全部", eventOrganization: "grouped"});
  assert.deepEqual(report.items.map(item => item.owner), ["未分配", "未分配", "未分配", "未分配", "未分配", "陈青"]);
  assert.deepEqual(examples, original);
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

const bpFile = {
  id: "bp-a", title: "示例 BP", category: "bp", archived: false, project_ids: ["active", "closed"], current_version: "v2-id",
  versions: [{id:"v1-id",filename:"BP-第一版.pdf"},{id:"v2-id",filename:"BP-第二版.pdf"}],
  records: [
    {id:"show",kind:"meeting",date:"2026-01-11",project_id:"active",version_id:"v2-id"},
    {id:"sent-a",kind:"sent",date:"2026-01-10",project_id:"active",version_id:"v1-id",people:["甲"],channel:"微信"},
    {id:"other",kind:"sent",date:"2026-01-12",project_id:"closed",version_id:"v2-id"},
    {id:"received",kind:"received",date:"2026-01-13",project_id:"active",version_id:"v2-id"},
  ],
};
test("BP status requires an actual send to this matter and keeps the version sent", () => {
  const before=structuredClone(bpFile);
  const rows=bpSendings("active",[bpFile,{...bpFile,id:"nda",category:"agreement"}]);
  assert.equal(rows.length,1);assert.equal(rows[0].versionLabel,"v1");assert.equal(rows[0].filename,"BP-第一版.pdf");
  assert.deepEqual(bpFile,before);
  assert.deepEqual(bpSendings("proactive",[bpFile]),[]);
  assert.deepEqual(bpSendings("active",[{...bpFile,records:bpFile.records.filter(r=>r.kind!=="sent")}]),[]);
});
test("multiple sends stay dated and moving a BP to trash does not erase its sending history", () => {
  const rows=bpSendings("active",[{...bpFile,archived:true,records:[...bpFile.records,{...bpFile.records[1],id:"sent-new",date:"2026-02-01",version_id:"v2-id"}]}]);
  assert.deepEqual(rows.map(r=>r.versionLabel),["v2","v1"]);assert.equal(rows[0].archived,true);
  assert.equal(bpSendings("active",[{...bpFile,versions:[]}])[0].versionLabel,"版本信息缺失");
});
test("BP sending filters respect authorized files and combine with other investment filters", () => {
  assert.deepEqual(filterInvestments(projects,{...defaults,bpStatus:"sent"},[bpFile]).map(p=>p.id),["active","closed"]);
  assert.deepEqual(filterInvestments(projects,{...defaults,bpStatus:"unrecorded"},[bpFile]).map(p=>p.id),["proactive"]);
  assert.deepEqual(filterInvestments(projects,{...defaults,bpStatus:"sent"},[]),[]);
  assert.deepEqual(filterInvestments(projects,{...defaults,bpStatus:"sent",followUp:"closed"},[bpFile]).map(p=>p.id),["closed"]);
});
