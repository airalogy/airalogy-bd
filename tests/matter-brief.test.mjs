import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function load(name, dependencies = {}) {
  const source = await readFile(new URL(`../dashboard/app/lib/${name}.ts`, import.meta.url), "utf8");
  const {outputText} = ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}});
  const exports = {};
  new Function("require", "exports", outputText)(key => { assert.ok(key in dependencies); return dependencies[key]; }, exports);
  return exports;
}
const {matterBriefMarkdown, matterBriefFilename} = await load("matter-brief", {"./labels":await load("labels")});
const project = {name:"单项合作",counterparties:["示例团队"],stage:"solution_discussion",record_type:"cooperation",follow_up_status:"awaiting_response",owner:"待确认",summary:"对方愿意进一步了解。",management_decisions:["评估下一步投入"],next_action:"联系对方沟通方案。",next_action_due:"2026-04-17",
  contacts:[{person_id:"p1",name:"林岚",affiliation:"示例单位",project_roles:["business_contact"],phone:"PRIVATE_PHONE",email:"PRIVATE_EMAIL",wechat:"PRIVATE_CHAT",notes:"PRIVATE_NOTES",projects:[{name:"UNRELATED_MATTER"}]}],
  events:[{date:"2026-04-10",title:"讨论方案",importance:"key",participants:["p1"],summary:"双方进行了讨论。",related_document:{title:"交流纪要",path:"PRIVATE_PATH",markdown:"## 反馈\n\n仅在全文出现的意见。\n\n- 第一项\n- 第二项"}},
    {date:"2026-04-02",title:"首次联系",importance:"normal",participants:[],summary:"初步了解需求。"}]};

test("one-matter brief includes all dated progress in order, separates proposals and limits profile fields",()=>{
  const before=structuredClone(project);
  const compact=matterBriefMarkdown(project), full=matterBriefMarkdown(project,true);
  for(const text of [compact,full]) {
    for(const present of ["示例团队","方案讨论","等待对方","林岚 · 示例单位 · 商务联系人","参与人：林岚",project.summary,project.next_action_due]) assert.ok(text.includes(present),present);
    const headings=["## 背景摘要","### 2026-04-02 首次联系","### 2026-04-10 讨论方案","## 下一步","## 待决事项"].map(marker=>text.indexOf(marker));
    assert.ok(headings.every((index,i)=>index>=0 && (!i||index>headings[i-1])));
    for(const excluded of ["PRIVATE_","UNRELATED_MATTER","待确认","p1"]) assert.ok(!text.includes(excluded),excluded);
  }
  assert.doesNotMatch(compact,/交流纪要|仅在全文出现|第一项/);
  assert.match(full,/> # 交流纪要\n>\n> ## 反馈/);
  assert.match(full,/> - 第一项\n> - 第二项/);
  assert.deepEqual(project,before);
});

test("empty or historical matters export only recorded content and a usable filename",()=>{
  const text=matterBriefMarkdown({...project,events:[],contacts:[],management_decisions:[],next_action:"",next_action_due:null},true,true);
  assert.match(text,/历史版本/);assert.match(text,/暂无沟通进展记录/);
  assert.doesNotMatch(text,/## 相关人员|## 待决事项|2026-04-17|完整沟通记录/);
  assert.equal(matterBriefFilename('合作/A:B'), '事项背景-合作-A-B.md');
});
